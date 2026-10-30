cmake_minimum_required(VERSION 3.13)

set(PICO_BOARD pico2_w CACHE STRING "Board")
include(pico_sdk_import.cmake)

project(ledwall_sender C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()

file(READ ${CMAKE_CURRENT_LIST_DIR}/VERSION FW_VERSION)
string(STRIP "${FW_VERSION}" FW_VERSION)

# Weboberfläche einbetten
add_custom_command(
    OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/web_index.h
    COMMAND ${CMAKE_COMMAND} -DIN=${CMAKE_CURRENT_LIST_DIR}/web/index.html -DOUT=${CMAKE_CURRENT_BINARY_DIR}/web_index.h
            -P ${CMAKE_CURRENT_LIST_DIR}/embed.cmake
    DEPENDS ${CMAKE_CURRENT_LIST_DIR}/web/index.html ${CMAKE_CURRENT_LIST_DIR}/embed.cmake
)

add_executable(ledwall_sender
    src/main.c
    src/bank.c
    src/player.c
    src/output.c
    src/settings.c
    src/web.c
    src/dhcpserver/dhcpserver.c
    ../common/protocol.c
    ${CMAKE_CURRENT_BINARY_DIR}/web_index.h
)
set_target_properties(ledwall_sender PROPERTIES OUTPUT_NAME ledwall-sender)

target_include_directories(ledwall_sender PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}
    ${CMAKE_CURRENT_LIST_DIR}/src
    ${CMAKE_CURRENT_LIST_DIR}/src/dhcpserver
    ${CMAKE_CURRENT_LIST_DIR}/../common
    ${CMAKE_CURRENT_BINARY_DIR}
)

target_compile_definitions(ledwall_sender PRIVATE
    FW_VERSION="${FW_VERSION}"
    USBD_MANUFACTURER="LEDWall"
    USBD_PRODUCT="LEDWall-Sender"
    PICO_STDIO_USB_CONNECT_WAIT_TIMEOUT_MS=0
    CYW43_HOST_NAME="ledwall"
)
target_compile_options(ledwall_sender PRIVATE -Wall -Wno-unused-parameter)

target_link_libraries(ledwall_sender
    pico_stdlib
    pico_cyw43_arch_lwip_poll
    pico_lwip_mdns
    pico_flash
    pico_unique_id
    hardware_dma
    hardware_uart
    hardware_flash
    hardware_watchdog
)

pico_enable_stdio_usb(ledwall_sender 1)
pico_enable_stdio_uart(ledwall_sender 0)
pico_add_extra_outputs(ledwall_sender)
