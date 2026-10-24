#pragma once
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace util {

// ---------- JSON ----------
class Json {
public:
  enum Type { Null, Bool, Number, String, Array, Object };
  Type type = Null;
  bool b = false;
  double num = 0.0;
  std::string str;
  std::vector<Json> arr;
  std::map<std::string, Json> obj;

  Json() {}
  static Json make_object();
  static Json make_array();
  static Json make_string(const std::string& s);
  static Json make_number(double n);
  static Json make_bool(bool v);

  bool is_null() const { return type == Null; }
  bool is_object() const { return type == Object; }
  bool is_array() const { return type == Array; }
  bool is_string() const { return type == String; }

  // object access
  Json& operator[](const std::string& key);
  const Json* get(const std::string& key) const;
  bool has(const std::string& key) const { return get(key) != nullptr; }
  std::string as_string(const std::string& def = "") const;
  double as_number(double def = 0.0) const;
  bool as_bool(bool def = false) const;
  int64_t as_int64(int64_t def = 0) const;

  std::string dump() const; // compact
  static Json parse(const std::string& text, std::string* err = nullptr);
  static Json parse_file(const std::string& path, std::string* err = nullptr);
};

// ---------- strings ----------
std::string to_lower(std::string s);
std::string trim(const std::string& s);
std::vector<std::string> split(const std::string& s, char delim);
bool starts_with(const std::string& s, const std::string& p);
bool ends_with(const std::string& s, const std::string& p);
std::string replace_all(std::string s, const std::string& from, const std::string& to);
std::string html_escape(const std::string& s);
bool is_ascii(const std::string& s);

// 头字段注入防护：把 CR/LF 等换成空格，保证单行、不可注入新头
std::string sanitize_header(const std::string& s);

// 按 UTF-8 字符（码点）截断，最多 max_chars 个字符；不会截断半个多字节序列。
std::string truncate_utf8_chars(const std::string& s, size_t max_chars);

// UTF-8 字符（码点）数量（非法序列按单字节计）。
size_t utf8_chars(const std::string& s);

// URL query/路径分量百分号编码（保留 RFC3986 unreserved 字符，其余 %XX）。
std::string url_encode_component(const std::string& s);

// 清洗用户输入的主机名：去掉 https:// 等协议头、路径、查询串、userinfo、空格；
// 若形如 "host:port" 且端口合法，则把端口写入 port（0 = 保持原端口不变）。
std::string normalize_host(const std::string& raw, int& port);

// ---------- base64 ----------
std::string b64_encode(const std::string& data);
std::string b64_decode(const std::string& data);

// ---------- quoted-printable ----------
std::string qp_decode(const std::string& data);  // body-style: soft line breaks removed
std::string q_decode(const std::string& data);   // RFC2047 Q-style: '_' -> ' '

// ---------- charset ----------
std::string charset_to_utf8(const std::string& s, const std::string& charset);

// ---------- time ----------
int64_t now_epoch();
std::string format_rfc5322(int64_t epoch);    // for composing mail
std::string format_local(int64_t epoch);      // "HH:MM" today, else "MM-DD HH:MM"
std::string format_local_full(int64_t epoch); // "YYYY-MM-DD HH:MM:SS"

} // namespace util