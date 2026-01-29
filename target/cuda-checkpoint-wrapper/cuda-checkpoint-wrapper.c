/*
 * cuda-checkpoint-wrapper - Wrapper for NVIDIA CUDA checkpoint driver API
 *
 * This wrapper is called by gVisor during checkpoint/restore operations.
 * It finds all GPU processes in the container and uses the CUDA driver API
 * to lock/checkpoint/restore/unlock each PID.
 *
 * Environment:
 *   GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE - "save", "restore", or "resume"
 *
 * This binary must be in the container:
 *   /etc/.tintin/cuda-snapshot - This wrapper
 */

#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define LOG_PREFIX "[cuda-checkpoint-wrapper] "
#define MAX_PIDS 256
#define NVIDIA_SMI "nvidia-smi"
#define CUDA_LIB "libcuda.so.1"

#define CUDA_SUCCESS 0
#define CU_GET_PROC_ADDRESS_DEFAULT 0ULL

typedef int CUresult;
typedef unsigned long long CUuint64;

typedef CUresult (*PFN_cuInit)(unsigned int flags);
typedef CUresult (*PFN_cuDriverGetVersion)(int *driverVersion);
typedef CUresult (*PFN_cuGetErrorName)(CUresult error, const char **pStr);
typedef CUresult (*PFN_cuGetErrorString)(CUresult error, const char **pStr);
typedef CUresult (*PFN_cuGetProcAddress)(const char *symbol, void **pfn, int cudaVersion, CUuint64 flags);
typedef CUresult (*PFN_cuCheckpointProcessLock)(int pid, void *args);
typedef CUresult (*PFN_cuCheckpointProcessCheckpoint)(int pid, void *args);
typedef CUresult (*PFN_cuCheckpointProcessRestore)(int pid, void *args);
typedef CUresult (*PFN_cuCheckpointProcessUnlock)(int pid, void *args);

typedef struct CudaApi {
    void *handle;
    int cuda_version;
    PFN_cuInit cuInit;
    PFN_cuDriverGetVersion cuDriverGetVersion;
    PFN_cuGetErrorName cuGetErrorName;
    PFN_cuGetErrorString cuGetErrorString;
    PFN_cuGetProcAddress cuGetProcAddress;
    PFN_cuCheckpointProcessLock cuCheckpointProcessLock;
    PFN_cuCheckpointProcessCheckpoint cuCheckpointProcessCheckpoint;
    PFN_cuCheckpointProcessRestore cuCheckpointProcessRestore;
    PFN_cuCheckpointProcessUnlock cuCheckpointProcessUnlock;
} CudaApi;

/* Static linking compatibility */
static void __attribute__((used)) __static_link_compat(void) {
    /* Empty function to ensure static linking works */
}

/* Get environment variable with default */
static const char *get_env(const char *key, const char *default_val) {
    const char *val = getenv(key);
    return val ? val : default_val;
}

/* Log to stderr */
static void log_info(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    fputs(LOG_PREFIX, stderr);
    vfprintf(stderr, fmt, args);
    fputs("\n", stderr);
    va_end(args);
}

static void log_error(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    fputs(LOG_PREFIX, stderr);
    fputs("ERROR: ", stderr);
    vfprintf(stderr, fmt, args);
    fputs("\n", stderr);
    va_end(args);
}

static void log_cuda_error(const CudaApi *api, CUresult result, const char *context, int pid) {
    const char *err_name = NULL;
    const char *err_str = NULL;

    if (api->cuGetErrorName) {
        api->cuGetErrorName(result, &err_name);
    }

    if (api->cuGetErrorString) {
        api->cuGetErrorString(result, &err_str);
    }

    if (pid >= 0) {
        log_error("%s for PID %d failed: %s (%s)",
                  context,
                  pid,
                  err_name ? err_name : "CUDA_ERROR_UNKNOWN",
                  err_str ? err_str : "no description");
    } else {
        log_error("%s failed: %s (%s)",
                  context,
                  err_name ? err_name : "CUDA_ERROR_UNKNOWN",
                  err_str ? err_str : "no description");
    }
}

static void *load_symbol(void *handle, const char *name) {
    void *sym;

    dlerror();
    sym = dlsym(handle, name);
    if (dlerror() != NULL) {
        return NULL;
    }

    return sym;
}

static int load_checkpoint_symbol(CudaApi *api, const char *name, void **out) {
    if (api->cuGetProcAddress) {
        void *symbol = NULL;
        CUresult result = api->cuGetProcAddress(name, &symbol, api->cuda_version, CU_GET_PROC_ADDRESS_DEFAULT);
        if (result == CUDA_SUCCESS && symbol != NULL) {
            *out = symbol;
            return 0;
        }
    }

    *out = load_symbol(api->handle, name);
    if (*out == NULL) {
        log_error("Failed to resolve %s in %s", name, CUDA_LIB);
        return -1;
    }

    return 0;
}

static int init_cuda_api(CudaApi *api) {
    CUresult result;

    memset(api, 0, sizeof(*api));
    api->handle = dlopen(CUDA_LIB, RTLD_NOW | RTLD_LOCAL);
    if (!api->handle) {
        log_error("Failed to load %s: %s", CUDA_LIB, dlerror());
        return -1;
    }

    api->cuInit = (PFN_cuInit)load_symbol(api->handle, "cuInit");
    if (!api->cuInit) {
        log_error("Failed to resolve cuInit in %s", CUDA_LIB);
        return -1;
    }

    api->cuDriverGetVersion = (PFN_cuDriverGetVersion)load_symbol(api->handle, "cuDriverGetVersion");
    api->cuGetErrorName = (PFN_cuGetErrorName)load_symbol(api->handle, "cuGetErrorName");
    api->cuGetErrorString = (PFN_cuGetErrorString)load_symbol(api->handle, "cuGetErrorString");
    api->cuGetProcAddress = (PFN_cuGetProcAddress)load_symbol(api->handle, "cuGetProcAddress");

    result = api->cuInit(0);
    if (result != CUDA_SUCCESS) {
        log_cuda_error(api, result, "cuInit", -1);
        return -1;
    }

    if (api->cuDriverGetVersion) {
        api->cuDriverGetVersion(&api->cuda_version);
    }

    if (load_checkpoint_symbol(api, "cuCheckpointProcessLock", (void **)&api->cuCheckpointProcessLock) != 0 ||
        load_checkpoint_symbol(api, "cuCheckpointProcessCheckpoint", (void **)&api->cuCheckpointProcessCheckpoint) != 0 ||
        load_checkpoint_symbol(api, "cuCheckpointProcessRestore", (void **)&api->cuCheckpointProcessRestore) != 0 ||
        load_checkpoint_symbol(api, "cuCheckpointProcessUnlock", (void **)&api->cuCheckpointProcessUnlock) != 0) {
        return -1;
    }

    return 0;
}

/*
 * Get all GPU process PIDs using nvidia-smi
 *
 * Uses: nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits
 *
 * Returns: number of PIDs found, or -1 on error
 */
static int get_gpu_pids(pid_t *pids, int max_pids) {
    int pipefd[2];
    pid_t pid;
    int count = 0;
    int overflow = 0;
    FILE *stream = NULL;
    char *line = NULL;
    size_t line_cap = 0;
    ssize_t line_len;
    int child_status = 0;
    int read_error = 0;

    if (pipe(pipefd) == -1) {
        log_error("pipe() failed: %s", strerror(errno));
        return -1;
    }

    pid = fork();
    if (pid == -1) {
        log_error("fork() failed: %s", strerror(errno));
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }

    if (pid == 0) {
        /* Child: run nvidia-smi */
        close(pipefd[0]); /* Close read end */
        dup2(pipefd[1], STDOUT_FILENO);
        close(pipefd[1]);

        execlp(NVIDIA_SMI, NVIDIA_SMI,
               "--query-compute-apps=pid",
               "--format=csv,noheader,nounits",
               NULL);

        _exit(127);
    }

    /* Parent: read output */
    close(pipefd[1]); /* Close write end */

    stream = fdopen(pipefd[0], "r");
    if (!stream) {
        log_error("fdopen() failed: %s", strerror(errno));
        close(pipefd[0]);
        waitpid(pid, NULL, 0);
        return -1;
    }

    while ((line_len = getline(&line, &line_cap, stream)) != -1) {
        char *cursor = line;
        while (isspace((unsigned char)*cursor)) {
            cursor++;
        }

        if (*cursor == '\0') {
            continue;
        }

        if (count >= max_pids) {
            overflow = 1;
            continue;
        }

        char *endptr;
        long val = strtol(cursor, &endptr, 10);
        if (val > 0 && val < INT_MAX) {
            pids[count++] = (pid_t)val;
        }
    }

    if (ferror(stream)) {
        log_error("Failed to read nvidia-smi output: %s", strerror(errno));
        read_error = 1;
    }

    fclose(stream);
    free(line);

    if (waitpid(pid, &child_status, 0) == -1) {
        log_error("waitpid() failed: %s", strerror(errno));
        return -1;
    }

    if (!WIFEXITED(child_status) || WEXITSTATUS(child_status) != 0) {
        int exit_code = WIFEXITED(child_status) ? WEXITSTATUS(child_status) : -1;
        log_error("nvidia-smi failed (exit code %d)", exit_code);
        return -1;
    }

    if (read_error) {
        return -1;
    }

    if (overflow) {
        log_error("Found more than %d GPU processes; extra PIDs ignored", max_pids);
    }

    log_info("Found %d GPU process(es)", count);
    return count;
}

static int checkpoint_pid(const CudaApi *api, pid_t pid) {
    CUresult result;

    result = api->cuCheckpointProcessLock((int)pid, NULL);
    if (result != CUDA_SUCCESS) {
        log_cuda_error(api, result, "cuCheckpointProcessLock", (int)pid);
        return -1;
    }

    result = api->cuCheckpointProcessCheckpoint((int)pid, NULL);
    if (result != CUDA_SUCCESS) {
        log_cuda_error(api, result, "cuCheckpointProcessCheckpoint", (int)pid);
        if (api->cuCheckpointProcessUnlock) {
            CUresult unlock_result = api->cuCheckpointProcessUnlock((int)pid, NULL);
            if (unlock_result != CUDA_SUCCESS) {
                log_cuda_error(api, unlock_result, "cuCheckpointProcessUnlock", (int)pid);
            }
        }
        return -1;
    }

    log_info("Checkpointed CUDA process PID %d", (int)pid);
    return 0;
}

static int restore_pid(const CudaApi *api, pid_t pid) {
    CUresult result;

    result = api->cuCheckpointProcessRestore((int)pid, NULL);
    if (result != CUDA_SUCCESS) {
        log_cuda_error(api, result, "cuCheckpointProcessRestore", (int)pid);
        return -1;
    }

    result = api->cuCheckpointProcessUnlock((int)pid, NULL);
    if (result != CUDA_SUCCESS) {
        log_cuda_error(api, result, "cuCheckpointProcessUnlock", (int)pid);
        return -1;
    }

    log_info("Restored CUDA process PID %d", (int)pid);
    return 0;
}

static int operate_all_cuda(const CudaApi *api, const char *mode) {
    pid_t pids[MAX_PIDS];
    int i;
    int count;
    int errors = 0;

    count = get_gpu_pids(pids, MAX_PIDS);
    if (count < 0) {
        return -1;
    }

    if (count == 0) {
        log_info("No GPU processes found - nothing to do");
        return 0;
    }

    if (strcmp(mode, "save") == 0) {
        log_info("Checkpointing %d process(es)...", count);
    } else {
        log_info("Restoring %d process(es)...", count);
    }

    for (i = 0; i < count; i++) {
        int rc;
        if (strcmp(mode, "save") == 0) {
            rc = checkpoint_pid(api, pids[i]);
        } else {
            rc = restore_pid(api, pids[i]);
        }

        if (rc != 0) {
            errors++;
        }
    }

    if (errors > 0) {
        log_error("Failed to process %d/%d CUDA process(es)", errors, count);
        return -1;
    }

    log_info("Processed %d CUDA process(es) successfully", count);
    return 0;
}

int main(int argc, char **argv) {
    const char *mode;
    const char *op_mode;
    int result;
    CudaApi api;

    (void)argc;
    (void)argv;

    mode = get_env("GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE", "unknown");
    op_mode = mode;

    if (strcmp(mode, "save") == 0) {
        log_info("Starting GPU save (checkpoint)");
    } else if (strcmp(mode, "restore") == 0) {
        log_info("Starting GPU restore");
    } else if (strcmp(mode, "resume") == 0) {
        log_info("Starting GPU resume");
        op_mode = "restore";
    } else {
        log_error("Unknown mode: %s (expected 'save', 'restore', or 'resume')", mode);
        fprintf(stderr, "Usage: This program must be called by gVisor with "
                        "GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE set to 'save', 'restore', or 'resume'\n");
        return 1;
    }

    if (init_cuda_api(&api) != 0) {
        log_error("Failed to initialize CUDA driver API");
        return 1;
    }

    result = operate_all_cuda(&api, op_mode);

    if (result == 0) {
        log_info("GPU checkpoint %s completed successfully", mode);
    } else {
        log_error("GPU checkpoint %s failed", mode);
    }

    return (result == 0) ? 0 : 1;
}
