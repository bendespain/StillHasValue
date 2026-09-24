# Shop image optimization

Product photos from Google Photos are often 12MP / multi-MB. Shop cards display ~280–400px wide.

**Before committing any `images/shv-*/` JPEG**, run:

```bash
python3 scripts/optimize-shop-images.py images/shv-NEWID/
# or all:
python3 scripts/optimize-shop-images.py images/
# CI / preflight:
python3 scripts/optimize-shop-images.py --check images/
```

Defaults: max long edge **1600px**, JPEG quality **80**, progressive. Target &lt; ~500KB per file.

The live shop HTML also wraps `stillhasvalue.com/images/…` URLs with Cloudflare Image Resizing (`/cdn-cgi/image/…`) so cards request ~400–800px even if a large original slips through.
