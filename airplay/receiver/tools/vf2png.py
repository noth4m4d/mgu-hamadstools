"""vf2png.py - turn the newest frame of a kit-renderer video file (/dev/shm/mgu-video-*) into a PNG.

    python vf2png.py frame.bin out.png
"""
import struct
import sys

from PIL import Image

data = open(sys.argv[1], 'rb').read()
magic, ver, w, h, seq, slot, nslot, matrix, rng = struct.unpack_from('<9I', data)
assert magic == 0x4656474d, 'not a video file'
fs = w * h * 3 // 2
off = 64 + slot * fs
y = Image.frombytes('L', (w, h), data[off:off + w * h])
u = Image.frombytes('L', (w // 2, h // 2), data[off + w * h:off + w * h + fs // 6]).resize((w, h))
v = Image.frombytes('L', (w // 2, h // 2), data[off + w * h + fs // 6:off + fs]).resize((w, h))
Image.merge('YCbCr', (y, u, v)).convert('RGB').save(sys.argv[2])
print(f'{w}x{h} seq {seq} slot {slot}/{nslot} matrix {"709" if matrix else "601"} range {"full" if rng else "limited"}')
