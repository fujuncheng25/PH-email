#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace mime {

// 附件大小限制（FEATURE-SPEC §3.2）：单附件 ≤ 16MB，合计 ≤ 24MB，超出跳过该附件。
constexpr long long kMaxAttachmentBytes = 16LL * 1024 * 1024;
constexpr long long kMaxAttachmentsTotal = 24LL * 1024 * 1024;

// 引用元数据（X-Email-Chatter-Quote 头 / message.quote 字段）。
struct Quote {
  std::string text;
  std::string from;
  int64_t ts = 0;
  std::string mid;
};

// 附件。解析时 data 为解码后的原始字节；app 层落盘后填写 file。
struct Attachment {
  std::string name;  // 原始文件名（已清洗路径分隔符）
  std::string mime;  // image/png 等
  long long size = 0;
  std::string data;  // 解析：原始字节；构建时可留空
  std::string file;  // data/attachments/ 下的文件名（后端生成）
  bool inline_ = false;  // 图片恒 true
};

struct Msg {
  std::string from;       // display name (may be empty)
  std::string from_addr;  // extracted email address (lowercased)
  std::string subject;
  std::string body_text;  // decoded text/plain (or stripped text/html), UTF-8
  std::string message_id;
  std::string date_raw;
  int64_t date_epoch = 0;  // 0 if unparsable
  std::string uid;         // IMAP UID（POP3 为空）；2.1 起用于“打开会话=标已读”
  std::string kind = "chat";       // chat | email | recall
  bool has_quote = false;          // 是否解析到 X-Email-Chatter-Quote
  Quote quote;                     // 引用元数据
  std::string recall_mid;          // X-Email-Chatter-Recall 的原 Message-ID
  std::vector<Attachment> attachments;  // 按 MIME 顺序
};

// 组信参数（build_message 扩展版）。
struct ComposeOptions {
  std::string from_display;
  std::string from_addr;
  std::string to_addr;
  std::string cc;  // 已拼接好的 Cc 头值（逗号分隔），空则不写头；Bcc 只进 SMTP 信封
  std::string subject;
  std::string body;
  std::string kind = "chat";  // chat | email | recall
  bool has_quote = false;
  Quote quote;
  std::string recall_mid;  // kind=recall 时写入 X-Email-Chatter-Recall
  std::vector<Attachment> attachments;  // 附件（data 填原始字节）
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

// 判断 mime 是否为图片（inline 附件判定）。
bool is_image_mime(const std::string& mime);

// Message-ID 合法性（2.1 reply 语义）：形如 <...>、无 CR/LF/空白、长度 ≤320。
bool valid_msgid(const std::string& mid);

// 主题加 "Re: " 前缀（大小写不敏感；已有 Re: 则不重复加）。2.1 引用=回复用。
std::string with_re_prefix(const std::string& subject);

// 把用户文件名清洗成安全形式：去掉路径分隔符/控制字符，长度受限（UTF-8 字符数）。
std::string sanitize_filename(const std::string& name, size_t max_chars = 80);

// Build a full MIME message (UTF-8, base64 body) for sending via SMTP.
// 若 out_msgid 非空，则写入本次生成的 Message-ID（便于调用方记录/去重）。
std::string build_message(const ComposeOptions& opt, std::string* out_msgid = nullptr);

// 兼容旧调用：普通 text/plain 聊天邮件。
std::string build_message(const std::string& from_display, const std::string& from_addr,
                          const std::string& to_addr, const std::string& subject,
                          const std::string& body, std::string* out_msgid = nullptr);

}  // namespace mime
