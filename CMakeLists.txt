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
  src/ai.cpp
  src/gguf.cpp
)
target_include_directories(email-chatter PRIVATE src)
target_link_libraries(email-chatter PRIVATE Threads::Threads)
if(OpenSSL_FOUND)
  target_link_libraries(email-chatter PRIVATE OpenSSL::SSL OpenSSL::Crypto)
endif()
if(WIN32)
  target_link_libraries(email-chatter PRIVATE ws2_32 crypt32)
endif()

# AI 引擎独立自测 CLI（tokenize/generate/logits/title/heuristic/info）。
# 与 email-chatter 分开：两者各有 main()，互不冲突；不复制 web 资源、不起服务。
add_executable(ai-selftest
  tools/ai_selftest.cpp
  src/ai.cpp
  src/gguf.cpp
  src/proto.cpp
  src/mime.cpp
  src/util.cpp
)
target_include_directories(ai-selftest PRIVATE src)
target_link_libraries(ai-selftest PRIVATE Threads::Threads)
if(OpenSSL_FOUND)
  target_link_libraries(ai-selftest PRIVATE OpenSSL::SSL OpenSSL::Crypto)
endif()
if(WIN32)
  target_link_libraries(ai-selftest PRIVATE ws2_32 crypt32)
endif()
if(WIN32 AND OpenSSL_FOUND)
  file(GLOB _ai_ssl_dlls "${OPENSSL_ROOT_DIR}/bin/libssl*.dll" "${OPENSSL_ROOT_DIR}/bin/libcrypto*.dll")
  if(_ai_ssl_dlls)
    add_custom_command(TARGET ai-selftest POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different ${_ai_ssl_dlls} $<TARGET_FILE_DIR:ai-selftest>
      COMMENT "Copying OpenSSL DLLs next to ai-selftest")
  endif()
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

# Windows: 把 OpenSSL 自带的 CA 证书包（Mozilla 根证书）复制到程序目录。
# 原因：Windows 上 OpenSSL 默认 OPENSSLDIR（C:\Program Files\Common Files\ssl）通常不存在，
# 而程序目录的 cacert.pem 会被 proto.cpp 的 TLS 信任链加载逻辑读取，保证证书校验可用。
if(WIN32 AND OpenSSL_FOUND)
  set(_ca_bundle "")
  foreach(_cand
      "${OPENSSL_ROOT_DIR}/ssl/cacert.pem"
      "${OPENSSL_ROOT_DIR}/ssl/cert.pem"
      "${OPENSSL_ROOT_DIR}/cacert.pem"
      "${OPENSSL_ROOT_DIR}/cert.pem")
    if(EXISTS "${_cand}")
      set(_ca_bundle "${_cand}")
      break()
    endif()
  endforeach()
  if(_ca_bundle)
    foreach(_tgt email-chatter ai-selftest)
      add_custom_command(TARGET ${_tgt} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different "${_ca_bundle}"
                "$<TARGET_FILE_DIR:${_tgt}>/cacert.pem"
        COMMENT "Copying CA bundle next to ${_tgt}")
    endforeach()
  endif()
endif()
