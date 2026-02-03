# cuda-checkpoint-wrapper

A wrapper program for NVIDIA's CUDA checkpoint driver API that enables GPU snapshotting with gVisor.

## Overview

When gVisor checkpoints a container with GPU memory, it needs to suspend CUDA state first. This wrapper:

1. Is invoked by gVisor via `--save-restore-exec-argv` flag
2. Reads `GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE` environment variable ("save", "restore", or "resume")
3. Finds all GPU processes in the container using `nvidia-smi`
4. Uses the CUDA driver API to checkpoint or restore each process

## Files

- `cuda-checkpoint-wrapper.c` - The wrapper program
- `CMakeLists.txt` - Build configuration

## Binary Layout

**On the AMI host:**
- `/opt/tintin/cuda-checkpoint` - This wrapper (what gVisor calls)

**Inside container:**
- `/etc/.tintin/cuda-snapshot` - Copy of wrapper (what gVisor executes)

## How It Works

### Save Mode (Checkpoint)

When `GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE=save`:

1. Wrapper finds all GPU processes via `nvidia-smi --query-compute-apps=pid`
2. Calls `cuCheckpointProcessLock(pid)` followed by `cuCheckpointProcessCheckpoint(pid)`
3. Each process transitions: **Running → Locked → Checkpointed**
   - GPU memory copied to host
   - GPU resources released
4. Container can now be checkpointed by gVisor

### Restore Mode

When `GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE=restore`:

1. Wrapper finds all GPU processes via `nvidia-smi --query-compute-apps=pid`
2. Calls `cuCheckpointProcessRestore(pid)` followed by `cuCheckpointProcessUnlock(pid)`
3. Each process transitions: **Checkpointed → Locked → Running**
   - GPU memory copied back to device
   - GPU resources re-acquired
4. Container resumes execution

### Resume Mode (--leave-running)

When `GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE=resume`:

- Uses the same flow as restore mode
- Restores CUDA memory and unlocks the process so it can keep running

## Requirements

- Linux x86_64
- NVIDIA driver with CUDA checkpointing support (driver 550+)
- `libcuda.so.1` available in the runtime environment
- `nvidia-smi` available in PATH

## Building

```bash
mkdir build
cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make
```

The binary will be at `build/cuda-checkpoint-wrapper`.

## Testing

```bash
# Test the wrapper (requires GPU and CUDA process)
export GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE=save
./build/cuda-checkpoint-wrapper
```
