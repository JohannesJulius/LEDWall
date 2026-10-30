cmake_minimum_required(VERSION 3.13)

set(PICO_BOARD waveshare_rp2040_zero CACHE STRING "Board")
include(pico_sdk_import.cmake)

project(ledwall_receiver C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()

file(READ ${CMAKE_CURRENT_LIST_DIR}/VERSION FW_VERSION)
string(STRIP "${FW_VERSION}" FW_VERSION)

add_executable(ledwall_receiver
    src/main.c
    src/hub75.c
    src/display.c
    src/config.c
    ../common/protocol.c
    src/status_led.c
)
set_target_properties(ledwall_receiver PROPERTIES OUTPUT_NAME ledwall-receiver)

pico_generate_pio_header(ledwall_receiver ${CMAKE_CURRENT_LIST_DIR}/src/hub75.pio)
pico_generate_pio_header(ledwall_receiver ${CMAKE_CURRENT_LIST_DIR}/src/ws2812.pio)

target_include_directories(ledwall_receiver PRIVATE ${CMAKE_CURRENT_LIST_DIR}/../common)

target_compile_definitions(ledwall_receiver PRIVATE
    FW_VERSION="${FW_VERSION}"
    USBD_MANUFACTURER="LEDWall"
    USBD_PRODUCT="LEDWall-Receiver"
    PICO_STDIO_USB_CONNECT_WAIT_TIMEOUT_MS=0
)
target_compile_options(ledwall_receiver PRIVATE -Wall -Wextra -Wno-unused-parameter -O2)

target_link_libraries(ledwall_receiver
    pico_stdlib
    pico_multicore
    pico_flash
    pico_unique_id
    hardware_pio
    hardware_dma
    hardware_uart
    hardware_flash
    hardware_watchdog
)

pico_enable_stdio_usb(ledwall_receiver 1)
pico_enable_stdio_uart(ledwall_receiver 0)
pico_add_extra_outputs(ledwall_receiver)
