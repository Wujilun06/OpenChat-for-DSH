"""生成 PWA 图标和占位头像。

画一只蓝底白鱼，跟这台机器上住的那条对齐。
系统 Python 没装 Pillow 时，用 DSH 自带那个解释器跑：

    "C:\\Users\\LECOO\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe" scripts/gen-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

BASE = 1024
RADIUS = 224
TOP = (92, 170, 255)
BOTTOM = (39, 104, 205)
OUT = Path(__file__).resolve().parent.parent / "apps" / "web" / "public"


def gradient() -> Image.Image:
    img = Image.new("RGB", (BASE, BASE))
    px = img.load()
    for y in range(BASE):
        t = y / (BASE - 1)
        color = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        for x in range(BASE):
            px[x, y] = color  # type: ignore[index]
    return img


def fish_layer(size: int = BASE) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    s = size / BASE

    def box(x0, y0, x1, y1):
        return [x0 * s, y0 * s, x1 * s, y1 * s]

    # 尾巴
    d.polygon([(340 * s, 525 * s), (170 * s, 415 * s), (170 * s, 635 * s)], fill=(255, 255, 255, 255))
    # 身子
    d.ellipse(box(300, 380, 790, 670), fill=(255, 255, 255, 255))
    # 眼睛
    d.ellipse(box(628, 452, 686, 510), fill=(26, 58, 112, 255))
    d.ellipse(box(650, 466, 672, 488), fill=(255, 255, 255, 255))
    # 小气泡
    d.ellipse(box(830, 300, 900, 370), outline=(255, 255, 255, 220), width=int(14 * s))
    return layer


def save(image: Image.Image, name: str, size: int) -> None:
    resized = image.resize((size, size), Image.LANCZOS)
    target = OUT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    resized.save(target, "PNG", optimize=True)
    print(f"  {target}  {size}x{size}")


def main() -> None:
    grad = gradient()
    fish = fish_layer()

    rounded = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    mask = Image.new("L", (BASE, BASE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, BASE - 1, BASE - 1], radius=RADIUS, fill=255)
    rounded.paste(grad, (0, 0), mask)
    rounded.alpha_composite(fish)

    # iOS 自己会切圆角，所以这个不能带透明角
    opaque = grad.convert("RGBA")
    opaque.alpha_composite(fish)

    print("生成图标：")
    save(rounded, "icons/icon-512.png", 512)
    save(rounded, "icons/icon-192.png", 192)
    save(opaque, "icons/apple-touch-icon.png", 180)
    save(rounded, "peer.png", 512)


if __name__ == "__main__":
    main()
