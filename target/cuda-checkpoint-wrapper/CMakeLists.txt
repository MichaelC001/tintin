cmake_minimum_required(VERSION 3.10)
project(cuda-checkpoint-wrapper C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -Wall -Wextra -O2")

# Build statically linked binary for maximum portability.
# This still uses dlopen to load libcuda.so.1 at runtime.
set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -static")

add_executable(cuda-checkpoint-wrapper cuda-checkpoint-wrapper.c)

target_link_libraries(cuda-checkpoint-wrapper dl)

# Install to /opt/tintin
install(TARGETS cuda-checkpoint-wrapper DESTINATION /opt/tintin)
