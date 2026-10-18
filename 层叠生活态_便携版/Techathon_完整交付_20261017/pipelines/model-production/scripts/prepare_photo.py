"""EXIF-correct a photo and crop one user-confirmed normalized rectangle."""
import argparse
import json
import math
from pathlib import Path
from PIL import Image, ImageOps


def prepare(source, output, box):
    if len(box) != 4 or not all(math.isfinite(v) for v in box):
        raise ValueError('bbox must contain four finite numbers')
    x, y, w, h = box
    if min(x, y) < 0 or min(w, h) <= 0 or x+w > 1 or y+h > 1:
        raise ValueError('bbox must be inside [0,1] in EXIF-corrected coordinates')
    source, output = Path(source), Path(output)
    if source.stat().st_size > 15 * 1024 * 1024:
        raise ValueError('Photo exceeds 15 MB')
    with Image.open(source) as original:
        if original.format not in ('JPEG', 'PNG', 'WEBP'):
            raise ValueError('Only JPEG, PNG and WebP supported')
        image = ImageOps.exif_transpose(original).convert('RGB')
        width, height = image.size
        bounds = (round(x*width), round(y*height), round((x+w)*width), round((y+h)*height))
        if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
            raise ValueError('Crop is smaller than one pixel')
        crop = image.crop(bounds)
        crop.thumbnail((2048, 2048))
        # A fresh image prevents inherited EXIF/metadata from being saved.
        clean = Image.new('RGB', crop.size)
        clean.paste(crop)
        output.parent.mkdir(parents=True, exist_ok=True)
        clean.save(output, format='PNG')
        metadata = {'sourceSize': [width, height], 'bbox': box, 'cropSize': list(clean.size),
                    'method': 'confirmed_rectangle', 'version': 1}
        output.with_suffix('.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
        return metadata


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source'); p.add_argument('output')
    p.add_argument('--bbox', nargs=4, type=float, required=True, metavar=('X','Y','W','H'))
    a = p.parse_args()
    print(json.dumps(prepare(a.source, a.output, a.bbox)))
