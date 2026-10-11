"""
Forced alignment of known lyrics (LRC) to audio: one timestamp per character
for Chinese, one per word for English.

Uses the same wav2vec2 CTC models as WhisperX and the same trellis / backtrack
method, but skips speech recognition: the text comes from your LRC, so there
are no misheard words.
  Chinese: jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn  (about 1.2 GB)
  English: facebook/wav2vec2-base-960h                          (about 360 MB)
The language is picked from the lyrics automatically (--lang to force it).

Usage:  python align_lrc.py <audio file> <lyrics.lrc> [--window 3] [--lang auto|zh|en] [--device cpu|cuda]
Output: <lyrics name>.aligned.lrc next to the LRC (word-level LRC, loads in index.html)
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request

MODELS = {
    "zh": ("jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn", "1.2 GB"),
    "en": ("facebook/wav2vec2-base-960h", "360 MB"),
}
SR = 16000
FRAME = 320 / SR                 # wav2vec2 emits one frame every 20 ms

CJK = re.compile(r"[㐀-鿿豈-﫿]")
KANA = re.compile(r"[\u3040-\u30ff]")
TIME_TAG = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
WORD_TAG = re.compile(r"<\d+:\d+(?:\.\d+)?>")
META = re.compile(r"^\s*\[([a-zA-Z]+):(.*)\]\s*$")
CREDIT = re.compile(r"著作权|^(lyrics|composed|produced|arranged|written|mixed|作词|作曲|编曲|制作)[^:：]{0,6}[:：]", re.I)
CREDIT_LABEL = re.compile(r"^[^:：]{1,24}[:：]")


# ---------------------------------------------------------------- LRC
def parse_lrc(text):
    meta, raw = {}, []
    for order, line in enumerate(text.splitlines()):
        tags = TIME_TAG.findall(line)
        if not tags:
            m = META.match(line)
            if m:
                meta[m.group(1).lower()] = m.group(2).strip()
            continue
        body = WORD_TAG.sub("", TIME_TAG.sub("", line)).strip()
        for mm, ss in tags:
            raw.append((int(mm) * 60 + float(ss), order, body))
    raw.sort()
    off = float(meta.get("offset", 0) or 0) / 1000
    lines, seen_lyric = [], False
    for t, _, body in raw:
        if not body or CREDIT.search(body) or (not seen_lyric and CREDIT_LABEL.match(body)):
            continue
        if t < 1.5 and meta.get("ar") and meta["ar"] in body:
            continue
        is_zh = bool(CJK.search(body)) and not KANA.search(body)   # Japanese (kanji + kana) is not Chinese
        if is_zh and lines and lines[-1]["en"] and not lines[-1]["zh"]:
            lines[-1]["zh"] = body          # translation of the previous line
            continue
        lines.append({"t": max(0.0, t - off), "en": "" if is_zh else body, "zh": body if is_zh else ""})
        seen_lyric = True
    return meta, lines


def tokens(text):
    """Same token split as index.html: characters for Chinese lines, words otherwise."""
    if CJK.search(text):
        return [c for c in text if c.strip()]
    return text.split()


def fmt(x):
    x = max(0.0, x)
    m = int(x // 60)
    return f"{m:02d}:{x - m * 60:05.2f}"


def word_lrc_text(meta, lines):
    out = [f"[{k}:{meta[k]}]" for k in ("ti", "ar", "al") if meta.get(k)]
    out.append("[by:逐字对齐 · wav2vec2 强制对齐 + LRC 文本]")
    for L in lines:
        main = L["en"] or L["zh"]
        wt = L.get("wt")
        if wt:
            s, k = "", 0
            pieces = list(main) if CJK.search(main) else re.split(r"(\s+)", main)
            for p in pieces:
                if not p.strip():
                    s += " " if p else ""
                    continue
                s += f"<{fmt(wt[k][0])}>{p}"
                k += 1
            out.append(f"[{fmt(wt[0][0])}]" + s + f"<{fmt(wt[-1][1])}>")
        else:
            out.append(f"[{fmt(L['t'])}]{main}")
        if L["en"] and L["zh"]:
            out.append(f"[{fmt(wt[0][0] if wt else L['t'])}]{L['zh']}")
    return "\n".join(out) + "\n"


def write_word_lrc(path, meta, lines):
    with open(path, "w", encoding="utf-8") as f:
        f.write(word_lrc_text(meta, lines))


# ---------------------------------------------------------------- per-line clean-up
def space_after_flags(text):
    """flags[k] is True when the lyric has a space between token k and token k+1."""
    flags, idx = [], 0
    pieces = list(text) if CJK.search(text) else re.split(r"(\s+)", text)
    for p in pieces:
        if not p.strip():
            if flags:
                flags[-1] = True
            continue
        flags.append(False)
        idx += 1
    return flags


def line_times(got, space_after, lrc_t, prev_last, next_start):
    """got: per-token (start, end) or None. Returns ([(start, end)], moved_first_char)."""
    n = len(got)
    known = [k for k in range(n) if got[k]]
    if not known:
        return None, 0
    starts = [got[k][0] for k in known]
    gaps = [b - a for a, b, k in zip(starts, starts[1:], known) if not space_after[k]]
    typical = sorted(gaps)[len(gaps) // 2] if gaps else 0.3
    typical = min(max(typical, 0.12), 0.6)
    st = [g[0] if g else None for g in got]
    for k in range(n):
        if st[k] is not None:
            continue
        left = max([q for q in known if q < k], default=None)
        right = min([q for q in known if q > k], default=None)
        if left is not None and right is not None:   # between two aligned characters: share the gap evenly
            st[k] = st[left] + (st[right] - st[left]) * (k - left) / (right - left)
        elif left is not None:                       # after the last aligned character: keep the line's pace
            st[k] = st[left] + typical * (k - left)
        else:                                        # before the first aligned character
            st[k] = max(prev_last + 0.05, st[right] - typical * (right - k))
    # characters after the last aligned one must stay before the next line
    limit = next_start - 0.05
    tail = [k for k in range(n) if st[k] >= limit]
    if tail:
        k0 = tail[0]
        base = st[k0 - 1] if k0 > 0 else prev_last
        step = max(0.03, (limit - base) / (n - k0 + 1))
        for i, k in enumerate(range(k0, n)):
            st[k] = base + step * (i + 1)
    # a first character far ahead of the rest of the line AND well before the LRC time is a mis-alignment
    moved = 0
    if n > 1 and not space_after[0]:
        g1 = st[1] - st[0]
        if g1 > max(1.0, 3 * typical) and st[0] < lrc_t - 1.0:
            st[0] = max(prev_last + 0.05, st[1] - typical)
            moved = 1
    for k in range(1, n):
        if st[k] <= st[k - 1]:
            st[k] = st[k - 1] + 0.02
    wt = []
    for k in range(n):
        end = got[k][1] if got[k] else st[k] + typical
        if k + 1 < n:
            end = min(end, st[k + 1])
        wt.append((st[k], max(end, st[k] + 0.05)))
    return wt, moved


# ---------------------------------------------------------------- audio
def load_audio(path):
    import numpy as np
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = "ffmpeg"
    cmd = [exe, "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    data = subprocess.run(cmd, stdout=subprocess.PIPE, check=True).stdout
    return np.frombuffer(data, dtype=np.float32).copy()


# ---------------------------------------------------------------- alignment
def trellis_align(emission, token_ids, blank, windows=None):
    """CTC forced alignment (torchaudio tutorial / WhisperX method).
    emission: [T, V] log-probs, token_ids: [J]. windows: per-token (first_frame, last_frame)
    in which the token may start, or None. Returns per-token (start_frame, end_frame) or None."""
    import numpy as np
    T, J = emission.shape[0], len(token_ids)
    if J == 0 or T < J:
        return None
    NEG = -1e30
    tr = np.full((T + 1, J + 1), NEG, dtype=np.float32)   # float32: English songs have thousands of letters
    tr[0, 0] = 0.0
    tr[1:, 0] = np.cumsum(emission[:, blank])
    ids = np.asarray(token_ids)
    allow = np.ones((T, J), dtype=bool)
    if windows is not None:
        for j, (a, b) in enumerate(windows):
            allow[:max(0, a), j] = False
            allow[min(T, b):, j] = False
    for t in range(T):
        stay = tr[t, 1:] + emission[t, blank]
        adv = tr[t, :-1] + emission[t, ids]
        adv = np.where(allow[t], adv, NEG)
        tr[t + 1, 1:] = np.maximum(stay, adv)
    if tr[T, J] <= NEG / 2:
        return None
    # backtrack
    spans = [[None, None] for _ in range(J)]
    t, j = T, J
    while j > 0 and t > 0:
        stay = tr[t - 1, j] + emission[t - 1, blank]
        adv = tr[t - 1, j - 1] + emission[t - 1, ids[j - 1]] if allow[t - 1, j - 1] else NEG
        if adv >= stay:
            spans[j - 1][0] = t - 1           # token j-1 emitted at frame t-1
            if spans[j - 1][1] is None:
                spans[j - 1][1] = t
            j -= 1
        else:
            if spans[j - 1][1] is None:
                spans[j - 1][1] = t           # trailing blanks after the token
        t -= 1
    if j > 0:
        return None
    return [(s, e) for s, e in spans]


def emissions(model, processor, audio, device, chunk_s=20.0, overlap_s=1.0):
    """Log-probs for the whole song, computed in overlapping chunks."""
    import numpy as np, torch
    hop = int((chunk_s - overlap_s) * SR)
    size = int(chunk_s * SR)
    keep = int(overlap_s / 2 / FRAME)
    parts = []
    starts = list(range(0, max(1, len(audio) - int(overlap_s * SR)), hop))
    for n, s in enumerate(starts):
        seg = audio[s:s + size]
        if len(seg) < 400:
            break
        iv = processor(seg, sampling_rate=SR, return_tensors="pt").input_values.to(device)
        with torch.inference_mode():
            lp = torch.log_softmax(model(iv).logits[0].float(), dim=-1).cpu().numpy()
        a = 0 if n == 0 else keep
        b = lp.shape[0] if n == len(starts) - 1 or s + size >= len(audio) else lp.shape[0] - keep
        parts.append(lp[a:b])
        print(f"\r  analysing audio {min(100, int((s + size) / len(audio) * 100))}%", end="", flush=True)
        if s + size >= len(audio):
            break
    print()
    return np.concatenate(parts, axis=0)


# ---------------------------------------------------------------- reusable API (used by main() and server.py)
_MODEL = {}


def prepare_hf_env(name):
    """Returns True when the model is already downloaded (then it is loaded with local_files_only,
    no network). Otherwise picks hf-mirror.com when huggingface.co is unreachable.
    The offline switch is per call, not process-wide, so a second model can still be downloaded later."""
    hf_home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
    model_dir = os.path.join(hf_home, "hub", "models--" + name.replace("/", "--"), "snapshots")
    cached = os.path.isdir(model_dir) and any(
        os.path.isfile(os.path.join(model_dir, d, "pytorch_model.bin")) for d in os.listdir(model_dir))
    if cached:
        return True
    for k in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        os.environ.pop(k, None)
    if not os.environ.get("HF_ENDPOINT"):
        try:
            urllib.request.urlopen("https://huggingface.co", timeout=6)
        except Exception:
            os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
            print("huggingface.co not reachable, using hf-mirror.com")
    # huggingface_hub reads these when it is imported; update it too in case it already is
    try:
        from huggingface_hub import constants as C
        C.HF_HUB_OFFLINE = False
        ep = os.environ.get("HF_ENDPOINT")
        if ep:
            C.ENDPOINT = ep.rstrip("/")
            C.HUGGINGFACE_CO_URL_TEMPLATE = C.ENDPOINT + "/{repo_id}/resolve/{revision}/{filename}"
    except Exception:
        pass
    return False


def get_model(lang="zh", device=None):
    """Load a wav2vec2 model once and keep it (the server reuses it between songs)."""
    import torch
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    name, size = MODELS[lang]
    key = (name, device)
    if key not in _MODEL:
        local = prepare_hf_env(name)
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        print(f"Loading model {name} on {device}" + ("" if local else f" (downloading about {size}, only this once)") + " ...")
        processor = Wav2Vec2Processor.from_pretrained(name, local_files_only=local)
        # use_safetensors=False: load pytorch_model.bin only, so no second copy of the weights is fetched
        model = Wav2Vec2ForCTC.from_pretrained(name, use_safetensors=False, local_files_only=local).to(device).eval()
        _MODEL[key] = (model, processor)
    model, processor = _MODEL[key]
    return model, processor, device


def detect_lang(lines):
    """zh when most lines (main text) are Chinese, else en."""
    zh = sum(1 for L in lines if CJK.search(L["en"] or L["zh"]))
    return "zh" if zh * 2 >= len(lines) else "en"


APOS = str.maketrans({"’": "'", "‘": "'", "`": "'", "´": "'"})


def model_chars(tok, vocab):
    """Characters of a token that the model knows (letters for English, the character itself for Chinese)."""
    out = []
    for c in tok.translate(APOS):
        for v in (c, c.upper(), c.lower()):
            if v in vocab:
                out.append(vocab[v])
                break
    return out


def align_lrc_text(audio, lrc_text, window=3.0, device=None, lang="auto"):
    """audio: float32 mono 16 kHz array. Returns (word-level LRC text, stats dict)."""
    meta, lines = parse_lrc(lrc_text)
    if not lines:
        raise ValueError("No timed lyric lines found in the LRC.")
    if sum(1 for L in lines if KANA.search(L["en"] or L["zh"])) * 2 >= len(lines):
        raise ValueError("日文歌还没有对齐模型（现在只支持中文和英文）。从 QQ音乐等平台下载的逐字歌词可以直接用。")
    if lang not in MODELS:
        lang = detect_lang(lines)
    print(f"Lyrics language: {'Chinese' if lang == 'zh' else 'English'}")
    model, processor, device = get_model(lang, device)
    vocab = processor.tokenizer.get_vocab()
    blank = processor.tokenizer.pad_token_id
    t0 = time.time()
    em = emissions(model, processor, audio, device)
    T = em.shape[0]

    # tokens to align, with the window each may start in (from the LRC line times).
    # Chinese: one model token per character. English: the letters of each word, then the
    # word separator "|" (the model emits it between words), as WhisperX does.
    sep = vocab.get("|") if lang == "en" else None
    flat, ids, wins = [], [], []
    for li, L in enumerate(lines):
        toks = tokens(L["en"] or L["zh"])
        L["toks"] = toks
        nxt = lines[li + 1]["t"] if li + 1 < len(lines) else len(audio) / SR
        a = int((L["t"] - window) / FRAME)
        b = int((nxt + window) / FRAME)
        w = (max(0, a), min(T, b))
        for k, tok in enumerate(toks):
            chars = model_chars(tok, vocab)  # none known (e.g. "2", "&"): filled in afterwards
            for c in chars:
                flat.append((li, k))
                ids.append(c)
                wins.append(w)
            if chars and sep is not None:
                flat.append(None)
                ids.append(sep)
                wins.append(w)

    spans = trellis_align(em, ids, blank, wins)
    if spans is None:
        print("Alignment inside the LRC time windows failed, retrying without windows ...")
        spans = trellis_align(em, ids, blank, None)
    if spans is None:
        raise ValueError("Alignment failed. Check that the audio and the lyrics are the same song.")

    times = {}                              # a word spans from its first letter to its last
    for key, (s, e) in zip(flat, spans):
        if key is None:
            continue
        if key in times:
            times[key] = (times[key][0], e * FRAME)
        else:
            times[key] = (s * FRAME, e * FRAME)
    aligned, moved_first, prev_last = 0, 0, 0.0
    for li, L in enumerate(lines):
        n = len(L["toks"])
        if n == 0:
            continue
        got = [times.get((li, k)) for k in range(n)]
        aligned += sum(1 for g in got if g)
        nxt = lines[li + 1]["t"] if li + 1 < len(lines) else len(audio) / SR
        wt, fixed = line_times(got, space_after_flags(L["en"] or L["zh"]), L["t"], prev_last, nxt)
        moved_first += fixed
        if wt:
            L["wt"] = wt
            prev_last = wt[-1][0]
    total = sum(len(L["toks"]) for L in lines)
    out = word_lrc_text(meta, lines)
    return out, {"aligned": aligned, "total": total, "moved": moved_first, "lang": lang,
                 "seconds": round(time.time() - t0, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("lrc")
    ap.add_argument("--window", type=float, default=3.0,
                    help="seconds a line may start before/after its LRC time (default 3)")
    ap.add_argument("--device", default=None)
    ap.add_argument("--lang", default="auto", choices=["auto", "zh", "en"],
                    help="lyrics language (default: picked from the lyrics)")
    args = ap.parse_args()

    with open(args.lrc, "rb") as f:
        raw = f.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("gbk", errors="replace")

    print("Reading audio ...")
    audio = load_audio(args.audio)
    try:
        out, st = align_lrc_text(audio, text, args.window, args.device, args.lang)
    except ValueError as e:
        sys.exit(str(e))
    path = os.path.splitext(args.lrc)[0] + ".aligned.lrc"
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
    unit = "characters" if st["lang"] == "zh" else "words"
    print(f"Aligned {st['aligned']} / {st['total']} {unit} in {st['seconds']:.0f} s"
          + (f", moved {st['moved']} stray line-start characters" if st["moved"] else ""))
    print(f"Saved: {path}")


if __name__ == "__main__":
    main()
