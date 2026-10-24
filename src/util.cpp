#include "util.hpp"

#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <sstream>

#if defined(__unix__) || defined(__APPLE__) || defined(__FreeBSD__)
#include <iconv.h>
#endif

#ifdef _WIN32
#include <windows.h>
#endif

namespace util {

// ============================== JSON ==============================

Json Json::make_object() { Json j; j.type = Object; return j; }
Json Json::make_array()  { Json j; j.type = Array;  return j; }
Json Json::make_string(const std::string& s) { Json j; j.type = String; j.str = s; return j; }
Json Json::make_number(double n) { Json j; j.type = Number; j.num = n; return j; }
Json Json::make_bool(bool v) { Json j; j.type = Bool; j.b = v; return j; }

Json& Json::operator[](const std::string& key) {
  if (type != Object) { type = Object; obj.clear(); }
  return obj[key];
}
const Json* Json::get(const std::string& key) const {
  if (type != Object) return nullptr;
  auto it = obj.find(key);
  return it == obj.end() ? nullptr : &it->second;
}
std::string Json::as_string(const std::string& def) const {
  return type == String ? str : def;
}
double Json::as_number(double def) const { return type == Number ? num : def; }
bool Json::as_bool(bool def) const { return type == Bool ? b : def; }
int64_t Json::as_int64(int64_t def) const { return type == Number ? (int64_t)num : def; }

namespace {
struct JParser {
  // 最大嵌套深度（安全边界）：防止构造的超深 JSON（如 '['*60000）递归耗尽栈。
  // 合法业务 JSON 深度远小于此值（消息对象/quote 只有 2-3 层）。
  static constexpr int kMaxDepth = 64;
  const std::string& s;
  size_t i = 0;
  std::string err;
  int depth = 0;
  explicit JParser(const std::string& str) : s(str) {}
  void skip_ws() {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
  }
  bool fail(const std::string& m) {
    if (err.empty()) err = m + " at offset " + std::to_string(i);
    return false;
  }
  bool parse_value(Json& out) {
    if (depth >= kMaxDepth) return fail("嵌套过深");
    ++depth;
    bool ok = parse_value_inner(out);
    --depth;
    return ok;
  }
  bool parse_value_inner(Json& out) {
    skip_ws();
    if (i >= s.size()) return fail("unexpected end of input");
    char c = s[i];
    if (c == '{') return parse_object(out);
    if (c == '[') return parse_array(out);
    if (c == '"') return parse_string(out);
    if (c == 't') { if (s.compare(i, 4, "true") == 0) { i += 4; out = Json::make_bool(true); return true; } return fail("bad literal"); }
    if (c == 'f') { if (s.compare(i, 5, "false") == 0) { i += 5; out = Json::make_bool(false); return true; } return fail("bad literal"); }
    if (c == 'n') { if (s.compare(i, 4, "null") == 0) { i += 4; out = Json(); return true; } return fail("bad literal"); }
    if (c == '-' || (c >= '0' && c <= '9')) return parse_number(out);
    return fail("unexpected character");
  }
  bool parse_number(Json& out) {
    size_t start = i;
    if (i < s.size() && s[i] == '-') ++i;
    while (i < s.size() && (isdigit((unsigned char)s[i]) || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) ++i;
    std::string tok = s.substr(start, i - start);
    try { out = Json::make_number(std::stod(tok)); return true; }
    catch (...) { return fail("bad number"); }
  }
  bool parse_string(Json& out) {
    if (i >= s.size() || s[i] != '"') return fail("expected string");
    ++i;
    std::string res;
    while (i < s.size()) {
      unsigned char c = (unsigned char)s[i];
      if (c == '"') { ++i; out = Json::make_string(res); return true; }
      if (c == '\\') {
        ++i;
        if (i >= s.size()) return fail("bad escape");
        char e = s[i];
        switch (e) {
          case '"': res += '"'; break;
          case '\\': res += '\\'; break;
          case '/': res += '/'; break;
          case 'b': res += '\b'; break;
          case 'f': res += '\f'; break;
          case 'n': res += '\n'; break;
          case 'r': res += '\r'; break;
          case 't': res += '\t'; break;
          case 'u': {
            if (i + 4 >= s.size()) return fail("bad unicode escape");
            unsigned cp = 0;
            for (int k = 1; k <= 4; ++k) {
              char h = s[i + k]; cp <<= 4;
              if (h >= '0' && h <= '9') cp |= (unsigned)(h - '0');
              else if (h >= 'a' && h <= 'f') cp |= (unsigned)(h - 'a' + 10);
              else if (h >= 'A' && h <= 'F') cp |= (unsigned)(h - 'A' + 10);
              else return fail("bad unicode hex");
            }
            i += 4;
            if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 < s.size() && s[i + 1] == '\\' && s[i + 2] == 'u') {
              unsigned lo = 0;
              for (int k = 0; k < 4; ++k) {
                char h = s[i + 3 + k]; lo <<= 4;
                if (h >= '0' && h <= '9') lo |= (unsigned)(h - '0');
                else if (h >= 'a' && h <= 'f') lo |= (unsigned)(h - 'a' + 10);
                else if (h >= 'A' && h <= 'F') lo |= (unsigned)(h - 'A' + 10);
                else { lo = 0xFFFF; break; }
              }
              if (lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                i += 6;
              }
            }
            if (cp < 0x80) res += (char)cp;
            else if (cp < 0x800) { res += (char)(0xC0 | (cp >> 6)); res += (char)(0x80 | (cp & 0x3F)); }
            else if (cp < 0x10000) { res += (char)(0xE0 | (cp >> 12)); res += (char)(0x80 | ((cp >> 6) & 0x3F)); res += (char)(0x80 | (cp & 0x3F)); }
            else { res += (char)(0xF0 | (cp >> 18)); res += (char)(0x80 | ((cp >> 12) & 0x3F)); res += (char)(0x80 | ((cp >> 6) & 0x3F)); res += (char)(0x80 | (cp & 0x3F)); }
            break;
          }
          default: return fail("bad escape character");
        }
        ++i;
      } else {
        res += (char)c;
        ++i;
      }
    }
    return fail("unterminated string");
  }
  bool parse_array(Json& out) {
    ++i; // '['
    out = Json::make_array();
    skip_ws();
    if (i < s.size() && s[i] == ']') { ++i; return true; }
    while (true) {
      Json v;
      if (!parse_value(v)) return false;
      out.arr.push_back(std::move(v));
      skip_ws();
      if (i >= s.size()) return fail("unterminated array");
      if (s[i] == ',') { ++i; continue; }
      if (s[i] == ']') { ++i; return true; }
      return fail("expected ',' or ']'");
    }
  }
  bool parse_object(Json& out) {
    ++i; // '{'
    out = Json::make_object();
    skip_ws();
    if (i < s.size() && s[i] == '}') { ++i; return true; }
    while (true) {
      skip_ws();
      if (i >= s.size() || s[i] != '"') return fail("expected object key string");
      Json key;
      if (!parse_string(key)) return false;
      skip_ws();
      if (i >= s.size() || s[i] != ':') return fail("expected ':'");
      ++i;
      Json v;
      if (!parse_value(v)) return false;
      out.obj[key.str] = std::move(v);
      skip_ws();
      if (i >= s.size()) return fail("unterminated object");
      if (s[i] == ',') { ++i; continue; }
      if (s[i] == '}') { ++i; return true; }
      return fail("expected ',' or '}'");
    }
  }
};

void dump_value(const Json& j, std::string& out) {
  switch (j.type) {
    case Json::Null: out += "null"; break;
    case Json::Bool: out += j.b ? "true" : "false"; break;
    case Json::Number: {
      double d = j.num;
      if (d == (long long)d && std::abs(d) < 1e15) out += std::to_string((long long)d);
      else {
        std::string t = std::to_string(d);
        while (t.size() > 1 && t.back() == '0') t.pop_back();
        if (!t.empty() && t.back() == '.') t.pop_back();
        out += t;
      }
      break;
    }
    case Json::String: {
      out += '"';
      for (char cc : j.str) {
        switch (cc) {
          case '"': out += "\\\""; break;
          case '\\': out += "\\\\"; break;
          case '\n': out += "\\n"; break;
          case '\r': out += "\\r"; break;
          case '\t': out += "\\t"; break;
          case '\b': out += "\\b"; break;
          case '\f': out += "\\f"; break;
          default:
            if ((unsigned char)cc < 0x20) {
              char buf[8];
              snprintf(buf, sizeof buf, "\\u%04x", (unsigned char)cc);
              out += buf;
            } else out += cc;
        }
      }
      out += '"';
      break;
    }
    case Json::Array: {
      out += '[';
      for (size_t k = 0; k < j.arr.size(); ++k) {
        if (k) out += ',';
        dump_value(j.arr[k], out);
      }
      out += ']';
      break;
    }
    case Json::Object: {
      out += '{';
      bool first = true;
      for (const auto& kv : j.obj) {
        if (!first) out += ',';
        first = false;
        Json k = Json::make_string(kv.first);
        dump_value(k, out);
        out += ':';
        dump_value(kv.second, out);
      }
      out += '}';
      break;
    }
  }
}
} // namespace

Json Json::parse(const std::string& text, std::string* err) {
  JParser p(text);
  Json out;
  if (!p.parse_value(out)) {
    if (err) *err = p.err;
    return Json();
  }
  p.skip_ws();
  if (p.i != text.size() && err) *err = "trailing data at offset " + std::to_string(p.i);
  return out;
}

Json Json::parse_file(const std::string& path, std::string* err) {
  std::ifstream f(path, std::ios::binary);
  if (!f) {
    if (err) *err = "cannot open " + path;
    return Json();
  }
  std::stringstream ss;
  ss << f.rdbuf();
  return parse(ss.str(), err);
}

std::string Json::dump() const {
  std::string out;
  dump_value(*this, out);
  return out;
}

// ============================== strings ==============================

std::string to_lower(std::string s) {
  for (char& c : s) c = (char)tolower((unsigned char)c);
  return s;
}
std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && isspace((unsigned char)s[a])) ++a;
  while (b > a && isspace((unsigned char)s[b - 1])) --b;
  return s.substr(a, b - a);
}
std::vector<std::string> split(const std::string& s, char delim) {
  std::vector<std::string> out;
  std::string cur;
  for (char c : s) {
    if (c == delim) { out.push_back(cur); cur.clear(); }
    else cur += c;
  }
  out.push_back(cur);
  return out;
}
bool starts_with(const std::string& s, const std::string& p) {
  return s.size() >= p.size() && s.compare(0, p.size(), p) == 0;
}
bool ends_with(const std::string& s, const std::string& p) {
  return s.size() >= p.size() && s.compare(s.size() - p.size(), p.size(), p) == 0;
}
std::string replace_all(std::string s, const std::string& from, const std::string& to) {
  if (from.empty()) return s;
  size_t pos = 0;
  while ((pos = s.find(from, pos)) != std::string::npos) {
    s.replace(pos, from.size(), to);
    pos += to.size();
  }
  return s;
}
std::string html_escape(const std::string& s) {
  std::string out;
  for (char c : s) {
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\'': out += "&#39;"; break;
      default: out += c;
    }
  }
  return out;
}
bool is_ascii(const std::string& s) {
  for (unsigned char c : s)
    if (c >= 0x80) return false;
  return true;
}

std::string normalize_host(const std::string& raw, int& port) {
  std::string s = trim(raw);
  if (s.empty()) return s;
  // 去掉协议头： https://  http://  imap://  smtp://  ...
  size_t scheme = s.find("://");
  if (scheme != std::string::npos) s = s.substr(scheme + 3);
  // 去掉路径 / 查询 / 锚点
  size_t cut = s.find_first_of("/?#");
  if (cut != std::string::npos) s = s.substr(0, cut);
  // 去掉 userinfo@
  size_t at = s.rfind('@');
  if (at != std::string::npos) s = s.substr(at + 1);
  // 去掉括号之类残留
  std::string cleaned;
  for (char c : s) {
    if (c == ' ' || c == '\t' || c == '\r' || c == '\n') continue;
    cleaned.push_back(c);
  }
  s = cleaned;
  if (s.empty()) return s;
  // IPv6 字面量形如 [::1]:993 —— 不做端口拆分，直接返回
  if (s.front() == '[') {
    size_t rb = s.find(']');
    if (rb == std::string::npos) return s;
    std::string host = s.substr(0, rb + 1);
    if (rb + 2 < s.size() && s[rb + 1] == ':') {
      int p = std::atoi(s.substr(rb + 2).c_str());
      if (p > 0 && p < 65536) port = p;
    }
    return host;
  }
  // host:port
  size_t colon = s.rfind(':');
  if (colon != std::string::npos && s.find(':') == colon) {
    std::string port_str = s.substr(colon + 1);
    bool digits = !port_str.empty();
    for (char c : port_str) if (c < '0' || c > '9') digits = false;
    int p = digits ? std::atoi(port_str.c_str()) : 0;
    if (p > 0 && p < 65536) {
      port = p;
      return s.substr(0, colon);
    }
  }
  return s;
}

std::string sanitize_header(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (char c : s) {
    if (c == '\r' || c == '\n' || c == '\0') out += ' ';
    else out += c;
  }
  return out;
}

std::string truncate_utf8_chars(const std::string& s, size_t max_chars) {
  size_t chars = 0;
  size_t i = 0;
  while (i < s.size() && chars < max_chars) {
    unsigned char c = (unsigned char)s[i];
    size_t len = 1;
    if (c >= 0xF0) len = 4;
    else if (c >= 0xE0) len = 3;
    else if (c >= 0xC0) len = 2;
    if (i + len > s.size()) len = s.size() - i;  // 非法/截断序列按剩余字节处理
    i += len;
    ++chars;
  }
  return s.substr(0, i);
}

size_t utf8_chars(const std::string& s) {
  size_t chars = 0;
  size_t i = 0;
  while (i < s.size()) {
    unsigned char c = (unsigned char)s[i];
    size_t len = 1;
    if (c >= 0xF0) len = 4;
    else if (c >= 0xE0) len = 3;
    else if (c >= 0xC0) len = 2;
    if (i + len > s.size()) len = s.size() - i;
    i += len;
    ++chars;
  }
  return chars;
}

std::string url_encode_component(const std::string& s) {
  static const char* hexd = "0123456789ABCDEF";
  std::string out;
  for (unsigned char c : s) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' ||
        c == '_' || c == '.' || c == '~') {
      out += (char)c;
    } else {
      out += '%';
      out += hexd[c >> 4];
      out += hexd[c & 15];
    }
  }
  return out;
}

// ============================== base64 ==============================

static const char B64T[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string b64_encode(const std::string& data) {
  std::string out;
  size_t i = 0, n = data.size();
  while (i + 3 <= n) {
    unsigned v = ((unsigned char)data[i] << 16) | ((unsigned char)data[i + 1] << 8) | (unsigned char)data[i + 2];
    out += B64T[(v >> 18) & 63];
    out += B64T[(v >> 12) & 63];
    out += B64T[(v >> 6) & 63];
    out += B64T[v & 63];
    i += 3;
  }
  size_t rem = n - i;
  if (rem == 1) {
    unsigned v = (unsigned char)data[i] << 16;
    out += B64T[(v >> 18) & 63];
    out += B64T[(v >> 12) & 63];
    out += "==";
  } else if (rem == 2) {
    unsigned v = ((unsigned char)data[i] << 16) | ((unsigned char)data[i + 1] << 8);
    out += B64T[(v >> 18) & 63];
    out += B64T[(v >> 12) & 63];
    out += B64T[(v >> 6) & 63];
    out += '=';
  }
  return out;
}

std::string b64_decode(const std::string& data) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  std::string out;
  unsigned buf = 0;
  int bits = 0;
  for (char c : data) {
    if (c == '=' || c == '\r' || c == '\n' || c == ' ' || c == '\t') continue;
    int v = val(c);
    if (v < 0) continue;
    buf = (buf << 6) | (unsigned)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += (char)((buf >> bits) & 0xFF);
    }
  }
  return out;
}

// ============================== quoted-printable ==============================

std::string qp_decode(const std::string& data) {
  std::string out;
  size_t i = 0, n = data.size();
  while (i < n) {
    unsigned char c = (unsigned char)data[i];
    if (c == '=') {
      if (i + 2 < n && data[i + 1] == '\r' && data[i + 2] == '\n') { i += 3; continue; } // soft break
      if (i + 1 < n && data[i + 1] == '\n') { i += 2; continue; }
      if (i + 2 < n) {
        char h1 = data[i + 1], h2 = data[i + 2];
        auto hex = [](char h) -> int {
          if (h >= '0' && h <= '9') return h - '0';
          if (h >= 'a' && h <= 'f') return h - 'a' + 10;
          if (h >= 'A' && h <= 'F') return h - 'A' + 10;
          return -1;
        };
        int a = hex(h1), b = hex(h2);
        if (a >= 0 && b >= 0) { out += (char)((a << 4) | b); i += 3; continue; }
      }
      out += '=';
      ++i;
    } else {
      out += (char)c;
      ++i;
    }
  }
  return out;
}

std::string q_decode(const std::string& data) {
  std::string out;
  size_t i = 0, n = data.size();
  while (i < n) {
    unsigned char c = (unsigned char)data[i];
    if (c == '_') { out += ' '; ++i; continue; }
    if (c == '=' && i + 2 < n) {
      auto hex = [](char h) -> int {
        if (h >= '0' && h <= '9') return h - '0';
        if (h >= 'a' && h <= 'f') return h - 'a' + 10;
        if (h >= 'A' && h <= 'F') return h - 'A' + 10;
        return -1;
      };
      int a = hex(data[i + 1]), b = hex(data[i + 2]);
      if (a >= 0 && b >= 0) { out += (char)((a << 4) | b); i += 3; continue; }
    }
    out += (char)c;
    ++i;
  }
  return out;
}

// ============================== charset ==============================

std::string charset_to_utf8(const std::string& s, const std::string& charset) {
  std::string cs = to_lower(trim(charset));
  cs = replace_all(cs, "\"", "");
  if (cs.empty() || cs == "utf-8" || cs == "utf8" || cs == "us-ascii" || cs == "ascii" ||
      cs == "binary") {
    return s;
  }
  // ISO-8859-1 / latin1：每个字节 0x80-0xFF 映射到 U+0080-U+00FF，必须真正转成 UTF-8，
  // 不能原样透传（否则产生非法 UTF-8，浏览器显示乱码）。
  if (cs == "iso-8859-1" || cs == "latin1" || cs == "latin-1") {
    std::string out;
    out.reserve(s.size() * 2);
    for (unsigned char c : s) {
      if (c < 0x80) {
        out += (char)c;
      } else {  // U+0080..U+00FF -> 2 字节 UTF-8
        out += (char)(0xC0 | (c >> 6));
        out += (char)(0x80 | (c & 0x3F));
      }
    }
    return out;
  }
#ifdef _WIN32
  UINT cp = 0;
  if (cs == "gbk" || cs == "gb2312" || cs == "gb18030" || cs == "cp936" || cs == "936" || cs == "gb_2312-80" || cs == "chinese") cp = 936;
  else if (cs == "big5" || cs == "big-5" || cs == "cp950") cp = 950;
  else if (cs == "shift_jis" || cs == "sjis" || cs == "cp932") cp = 932;
  else if (cs == "euc-kr" || cs == "ks_c_5601-1987" || cs == "cp949") cp = 949;
  if (cp) {
    int wlen = MultiByteToWideChar(cp, 0, s.c_str(), (int)s.size(), nullptr, 0);
    if (wlen > 0) {
      std::wstring w((size_t)wlen, 0);
      MultiByteToWideChar(cp, 0, s.c_str(), (int)s.size(), &w[0], wlen);
      int ulen = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), wlen, nullptr, 0, nullptr, nullptr);
      if (ulen > 0) {
        std::string u((size_t)ulen, 0);
        WideCharToMultiByte(CP_UTF8, 0, w.c_str(), wlen, &u[0], ulen, nullptr, nullptr);
        return u;
      }
    }
    return s;
  }
#else
  const char* enc = nullptr;
  if (cs == "gbk" || cs == "gb2312" || cs == "gb18030" || cs == "cp936" || cs == "936" || cs == "gb_2312-80" || cs == "chinese") enc = "GBK";
  else if (cs == "big5" || cs == "big-5" || cs == "cp950") enc = "BIG5";
  else if (cs == "shift_jis" || cs == "sjis" || cs == "cp932") enc = "SHIFT_JIS";
  else if (cs == "euc-kr" || cs == "ks_c_5601-1987" || cs == "cp949") enc = "EUC-KR";
  else if (cs == "iso-8859-1" || cs == "latin1") enc = "ISO-8859-1";
  else enc = cs.c_str();
  iconv_t cd = iconv_open("UTF-8", enc);
  if (cd != (iconv_t)-1) {
    std::string out(s.size() * 3 + 16, '\0');
    char* inbuf = const_cast<char*>(s.data());
    size_t inleft = s.size();
    char* outbuf = &out[0];
    size_t outleft = out.size();
    size_t r = iconv(cd, &inbuf, &inleft, &outbuf, &outleft);
    iconv_close(cd);
    if (r != (size_t)-1) {
      out.resize(out.size() - outleft);
      return out;
    }
  }
#endif
  return s;
}

// ============================== time ==============================

int64_t now_epoch() { return (int64_t)time(nullptr); }

static void tm_local(const time_t* t, std::tm* out) {
#ifdef _WIN32
  localtime_s(out, t);
#else
  localtime_r(t, out);
#endif
}

std::string format_rfc5322(int64_t epoch) {
  time_t t = (time_t)epoch;
  std::tm g;
#ifdef _WIN32
  gmtime_s(&g, &t);
#else
  gmtime_r(&t, &g);
#endif
  static const char* days[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
  static const char* months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
  char buf[96];
  snprintf(buf, sizeof buf, "%s, %02d %s %04d %02d:%02d:%02d +0000",
           days[g.tm_wday], g.tm_mday, months[g.tm_mon], g.tm_year + 1900,
           g.tm_hour, g.tm_min, g.tm_sec);
  return buf;
}

std::string format_local(int64_t epoch) {
  time_t t = (time_t)epoch;
  std::tm l;
  tm_local(&t, &l);
  time_t tnow = time(nullptr);
  std::tm lnow;
  tm_local(&tnow, &lnow);
  char buf[64];
  if (l.tm_year == lnow.tm_year && l.tm_yday == lnow.tm_yday)
    snprintf(buf, sizeof buf, "%02d:%02d", l.tm_hour, l.tm_min);
  else
    snprintf(buf, sizeof buf, "%02d-%02d %02d:%02d", l.tm_mon + 1, l.tm_mday, l.tm_hour, l.tm_min);
  return buf;
}

std::string format_local_full(int64_t epoch) {
  time_t t = (time_t)epoch;
  std::tm l;
  tm_local(&t, &l);
  char buf[64];
  snprintf(buf, sizeof buf, "%04d-%02d-%02d %02d:%02d:%02d",
           l.tm_year + 1900, l.tm_mon + 1, l.tm_mday, l.tm_hour, l.tm_min, l.tm_sec);
  return buf;
}

} // namespace util