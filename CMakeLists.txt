cmake_minimum_required(VERSION 3.16)
project(email-chatter CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Threads REQUIRED)
find_package(OpenSSL QUIET)
if(OpenSSL_FOUND)
  message(STATUS "OpenSSL found (${OPENSSL_VERSION}): TLS support ENABLED")
  add_compile_definitions(HAS_OPENSSL=1)
else()
  message(WARNING "OpenSSL NOT found - building WITHOUT TLS. "
                  "Real internet email servers require TLS; install OpenSSL dev headers for full support.")
endif()

add_executable(email-chatter
  src/main.cpp
  src/util.cpp
  src/mime.cpp
  src/proto.cpp
  src/http.cpp
  src/app.cpp
)
target_include_directories(email-chatter PRIVATE src)
target_link_libraries(email-chatter PRIVATE Threads::Threads)
if(OpenSSL_FOUND)
  target_link_libraries(email-chatter PRIVATE OpenSSL::SSL OpenSSL::Crypto)
endif()
if(WIN32)
  target_link_libraries(email-chatter PRIVATE ws2_32)
endif()

# Copy web assets next to the binary so the server can find them at runtime.
add_custom_command(TARGET email-chatter POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory
          ${CMAKE_SOURCE_DIR}/web $<TARGET_FILE_DIR:email-chatter>/web
  COMMENT "Copying web assets next to the binary")

# On Windows, if OpenSSL DLLs are available next to the libs (e.g. conda layout),
# copy them next to the binary so it runs standalone.
if(WIN32 AND OpenSSL_FOUND)
  file(GLOB _ssl_dlls "${OPENSSL_ROOT_DIR}/bin/libssl*.dll" "${OPENSSL_ROOT_DIR}/bin/libcrypto*.dll")
  if(_ssl_dlls)
    add_custom_command(TARGET email-chatter POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different ${_ssl_dlls} $<TARGET_FILE_DIR:email-chatter>
      COMMENT "Copying OpenSSL DLLs next to the binary")
  endif()
endif()
