#pragma once
#include <cstdint>
#include <string>

namespace mime {

struct Msg {
  std::string from;       // display name (may be empty)
  std::string from_addr;  // extracted email address (lowercased)
  std::string subject;
  std::string body_text;  // decoded text/plain (or stripped text/html), UTF-8
  std::string message_id;
  std::string date_raw;
  int64_t date_epoch = 0; // 0 if unparsable
};

// Parse a full RFC822/MIME raw message into Msg.
bool parse_message(const std::string& raw, Msg& out);

// Decode RFC2047 encoded words in a header value (=?charset?B?...?= / =?charset?Q?...?=).
std::string decode_encoded_words(const std::string& s);

// Extract a bare email address from a From/To header value.
std::string extract_addr(const std::string& from_header);

// Parse an RFC5322 date string to epoch seconds.
int64_t parse_date(const std::string& s);

// Encode a subject/display-name header value for composing (RFC2047 B-encoding when non-ASCII).
std::string encode_header(const std::string& s);

// Strip HTML to plain text (for html bodies).
std::string strip_html(const std::string& html);

// Build a full MIME message (UTF-8, base64 body) for sending via SMTP.
// 若 out_msgid 非空，则写入本次生成的 Message-ID（便于调用方记录/去重）。
std::string build_message(const std::string& from_display, const std::string& from_addr,
                          const std::string& to_addr, const std::string& subject,
                          const std::string& body, std::string* out_msgid = nullptr);

} // namespace mime