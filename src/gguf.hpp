#pragma once
// GGUF 解析 + Qwen2 tokenizer / 前向推理（C++17，无第三方依赖）。
// 实现：gguf.cpp。自测入口：tools/ai_selftest.cpp。
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace gguf {

// GGML 张量类型编号（与 GGUF 规范一致）。
enum Type {
  T_F32 = 0,
  T_F16 = 1,
  T_Q4_0 = 2,
  T_Q4_1 = 3,
  T_Q5_0 = 6,
  T_Q5_1 = 7,
  T_Q8_0 = 8,
  T_Q4_K = 12,
  T_Q5_K = 13,
  T_Q6_K = 14,
  T_BF16 = 30,
};

const char* type_name(uint32_t type);
bool type_supported(uint32_t type);

// 只读 GGUF 文件：整个文件读入内存，张量指向文件缓冲（零拷贝）。
class Model {
 public:
  struct TensorInfo {
    std::string name;
    std::vector<uint64_t> dims;  // ne0, ne1, ...（ne0 为一行的元素数）
    uint32_t type = 0;
    uint64_t offset = 0;  // 相对 data 区起点
    const uint8_t* data = nullptr;
    size_t nbytes = 0;
    uint64_t nelements = 0;
  };

  Model();
  ~Model();
  Model(const Model&) = delete;
  Model& operator=(const Model&) = delete;

  bool load(const std::string& path, std::string& err);
  void unload();
  bool loaded() const;
  const std::string& path() const;
  size_t file_size() const;
  uint64_t alignment() const;

  const TensorInfo* tensor(const std::string& name) const;
  const std::vector<TensorInfo>& tensors() const;

  bool has_kv(const std::string& key) const;
  std::string get_str(const std::string& key, const std::string& def = "") const;
  int64_t get_int(const std::string& key, int64_t def = 0) const;
  double get_float(const std::string& key, double def = 0) const;
  bool get_bool(const std::string& key, bool def = false) const;
  const std::vector<std::string>* get_str_array(const std::string& key) const;
  const std::vector<int64_t>* get_int_array(const std::string& key) const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// 把张量第 row 行反量化到 out（长度 = dims[0]，即一行元素数）。
// 用于自测/调试（与 llama.cpp/ggml 的 dequantize_row_* 对照）。
bool dequantize_row(const Model::TensorInfo& t, uint64_t row, std::vector<float>& out);

// GPT-2 byte-level BPE + Qwen2 预切分正则。
class Tokenizer {
 public:
  Tokenizer();
  ~Tokenizer();
  Tokenizer(const Tokenizer&) = delete;
  Tokenizer& operator=(const Tokenizer&) = delete;

  bool init(const Model& model, std::string& err);
  void reset();
  bool ready() const;
  int n_vocab() const;
  int bos_id() const;
  int eos_id() const;
  int pad_id() const;
  int token_id(const std::string& token_text) const;  // 不存在返回 -1

  // parse_special=true 时先识别 <|im_start|> 等控制 token。
  std::vector<int> encode(const std::string& text, bool parse_special = false) const;
  // keep_special=true 时 CONTROL/USER_DEFINED token 输出其字面文本（默认跳过）。
  std::string decode(const std::vector<int>& ids, bool keep_special = false) const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// Qwen2 GGUF 推理引擎（RMSNorm / QKV+bias / NeoX RoPE / GQA / KV cache / SwiGLU / lm_head）。
class Qwen2Engine {
 public:
  Qwen2Engine();
  ~Qwen2Engine();
  Qwen2Engine(const Qwen2Engine&) = delete;
  Qwen2Engine& operator=(const Qwen2Engine&) = delete;

  bool load(const std::string& path, std::string& err);
  void unload();
  bool loaded() const;
  const Tokenizer& tokenizer() const;
  std::string model_name() const;
  size_t memory_bytes() const;

  // 对完整 token 序列做一次前向，返回最后位置的 logits（长度 n_vocab）。
  bool compute_logits(const std::vector<int>& ids, std::vector<float>& logits, std::string& err);
  // 贪心生成：out_ids 只追加新生成的 token（不含 prompt；遇 eos/换行/上限停止）。
  bool generate(const std::vector<int>& prompt, int max_new, bool stop_on_newline,
                std::vector<int>& out_ids, std::string& err);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace gguf
