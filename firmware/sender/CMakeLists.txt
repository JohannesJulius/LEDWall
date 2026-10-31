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

# Zwei Varianten aus demselben Code:
#  ledwall-sender.uf2  normal: schickt Bilder per UART an die RP2040-Zero-Empfänger
#  ledwall-direct.uf2  Direktbetrieb: HUB75-Panels hängen direkt am Pico 2W
function(ledwall_target NAME OUTPUT DIRECT)
    add_executable(${NAME}
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
    set_target_properties(${NAME} PROPERTIES OUTPUT_NAME ${OUTPUT})
    target_include_directories(${NAME} PRIVATE
        ${CMAKE_CURRENT_LIST_DIR}
        ${CMAKE_CURRENT_LIST_DIR}/src
        ${CMAKE_CURRENT_LIST_DIR}/src/dhcpserver
        ${CMAKE_CURRENT_LIST_DIR}/../common
        ${CMAKE_CURRENT_BINARY_DIR}
    )
    target_compile_definitions(${NAME} PRIVATE
        FW_VERSION="${FW_VERSION}"
        USBD_MANUFACTURER="LEDWall"
        USBD_PRODUCT="LEDWall-Sender"
        PICO_STDIO_USB_CONNECT_WAIT_TIMEOUT_MS=0
        CYW43_HOST_NAME="ledwall"
        LEDWALL_DIRECT=${DIRECT}
    )
    target_compile_options(${NAME} PRIVATE -Wall -Wno-unused-parameter)
    target_link_libraries(${NAME}
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
    if (DIRECT)
        target_sources(${NAME} PRIVATE
            src/direct/direct.c
            src/direct/hub75d.c
            ../receiver/src/display.c
            ../receiver/src/config.c
        )
        target_include_directories(${NAME} PRIVATE ${CMAKE_CURRENT_LIST_DIR}/src/direct ${CMAKE_CURRENT_LIST_DIR}/../receiver/src)
        pico_generate_pio_header(${NAME} ${CMAKE_CURRENT_LIST_DIR}/src/direct/hub75d.pio)
        target_link_libraries(${NAME} pico_multicore hardware_pio)
    endif()
    pico_enable_stdio_usb(${NAME} 1)
    pico_enable_stdio_uart(${NAME} 0)
    pico_add_extra_outputs(${NAME})
endfunction()

ledwall_target(ledwall_sender ledwall-sender 0)
ledwall_target(ledwall_direct ledwall-direct 1)
