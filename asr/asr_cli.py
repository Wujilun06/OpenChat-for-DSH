"""把一段 wav 转成文字。

给服务端当子进程用：读一个 16kHz 单声道 16bit 的 wav，打一行 JSON 到 stdout。

    python asr_cli.py --model-dir <dir> <file.wav>

模型是 SenseVoice（sherpa-onnx 的 int8 版），只做转写，不存音频。
"""

import argparse
import json
import os
import sys

import numpy as np
import sherpa_onnx


def load_recognizer(model_dir: str, threads: int) -> "sherpa_onnx.OfflineRecognizer":
    model = os.path.join(model_dir, "model.int8.onnx")
    tokens = os.path.join(model_dir, "tokens.txt")
    missing = [p for p in (model, tokens) if not os.path.exists(p)]
    if missing:
        raise SystemExit("模型文件不在：" + ", ".join(missing))
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model,
        tokens=tokens,
        num_threads=max(1, threads),
        use_itn=True,
        debug=False,
    )


def read_wav(path: str) -> np.ndarray:
    import wave

    with wave.open(path, "rb") as f:
        rate = f.getframerate()
        channels = f.getnchannels()
        width = f.getsampwidth()
        raw = f.readframes(f.getnframes())

    if rate != 16000 or channels != 1 or width != 2:
        raise SystemExit(f"要 16k 单声道 16bit 的 wav，拿到的是 {rate}/{channels}/{width}")

    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("wav", nargs="?")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()

    if args.self_check:
        load_recognizer(args.model_dir, args.threads)
        print(json.dumps({"ok": True, "self_check": True}))
        return

    if not args.wav:
        raise SystemExit("要一个 wav 文件")

    samples = read_wav(args.wav)
    recognizer = load_recognizer(args.model_dir, args.threads)
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)

    print(json.dumps({"ok": True, "text": stream.result.text.strip()}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 —— 子进程里出错要让上层看见原因
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
