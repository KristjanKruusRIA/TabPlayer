use super::pdf::{SvgPage, export_options, notation_tree};
use super::svg::unresolved_text;
use resvg::tiny_skia;

/// One RGBA page buffer: 64 million pixels is 256 MB.
const PAGE_PIXELS: u64 = 64_000_000;
/// Rendering time and the encoded pages held until writing grow with the whole export.
const EXPORT_PIXELS: u64 = 1_500_000_000;

/// Rasterizes each page at the chosen resolution and encodes it as RGBA PNG with its physical size.
pub fn render_pages(pages: &[SvgPage], dpi: u32) -> Result<Vec<Vec<u8>>, String> {
    if !(72..=600).contains(&dpi) {
        return Err("Choose a resolution from 72 to 600 dpi.".into());
    }
    if pages.is_empty() || pages.len() > 2000 {
        return Err("Choose between one and 2000 pages.".into());
    }
    // Size every page before parsing or rendering any of them.
    let sizes: Vec<_> = pages
        .iter()
        .map(|page| (pixels(page.width_mm, dpi), pixels(page.height_mm, dpi)))
        .collect();
    let area = |&(width, height): &(u32, u32)| u64::from(width) * u64::from(height);
    if sizes.iter().any(|size| area(size) > PAGE_PIXELS) {
        return Err(
            "This page is too large for that resolution. Choose a lower resolution.".into(),
        );
    }
    if sizes.iter().map(area).sum::<u64>() > EXPORT_PIXELS {
        return Err(
            "This export is too large for that resolution. Choose a lower resolution or fewer pages."
                .into(),
        );
    }
    let options = export_options();
    pages
        .iter()
        .zip(sizes)
        .map(|(page, (width, height))| {
            let tree = notation_tree(page, &options, "PNG")?;
            if unresolved_text(tree.root()) {
                return Err("A piece of text could not be displayed with any font.".into());
            }
            let mut pixmap = tiny_skia::Pixmap::new(width, height)
                .ok_or("This page is too large for that resolution. Choose a lower resolution.")?;
            let size = tree.size();
            let scale = tiny_skia::Transform::from_scale(
                width as f32 / size.width(),
                height as f32 / size.height(),
            );
            resvg::render(&tree, scale, &mut pixmap.as_mut());
            encode(pixmap, dpi)
        })
        .collect()
}

/// Saturating: NaN becomes 0 and is refused by `notation_tree`; infinity exceeds the page limit.
fn pixels(mm: f32, dpi: u32) -> u32 {
    (f64::from(mm) / 25.4 * f64::from(dpi)).round() as u32
}

fn encode(pixmap: tiny_skia::Pixmap, dpi: u32) -> Result<Vec<u8>, String> {
    let (width, height) = (pixmap.width(), pixmap.height());
    // tiny-skia stores premultiplied colour; PNG expects straight alpha.
    let mut rgba = pixmap.take();
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = u32::from(pixel[3]);
        if alpha > 0 && alpha < 255 {
            for channel in &mut pixel[..3] {
                *channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
    }
    let failed = |e: png::EncodingError| format!("Could not write the PNG image: {e}");
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_srgb(png::SrgbRenderingIntent::Perceptual);
    let per_metre = (f64::from(dpi) / 0.0254).round() as u32;
    encoder.set_pixel_dims(Some(png::PixelDimensions {
        xppu: per_metre,
        yppu: per_metre,
        unit: png::Unit::Meter,
    }));
    let mut writer = encoder.write_header().map_err(failed)?;
    writer.write_image_data(&rgba).map_err(failed)?;
    writer.finish().map_err(failed)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    const BACKGROUND: &str = "<rect width='100%' height='100%' fill='#fff'/>";
    fn page_with(width_mm: f32, height_mm: f32, content: &str) -> SvgPage {
        SvgPage {
            width_mm,
            height_mm,
            svg: format!(
                "<svg xmlns='http://www.w3.org/2000/svg' width='{width_mm}mm' height='{height_mm}mm' viewBox='0 0 794 1123'>{content}</svg>"
            ),
        }
    }
    fn notation(background: bool) -> SvgPage {
        page_with(
            210.0,
            297.0,
            &format!(
                "{}<text x='60' y='70' font-family='Noto Sans' font-size='40'>TabPlayer Ä</text><text x='100' y='200' font-family='Bravura' font-size='34'>&#57424;</text><text x='700' y='1000' font-family='Noto Sans' font-size='40'>end</text>",
                if background { BACKGROUND } else { "" }
            ),
        )
    }
    struct Image {
        width: u32,
        height: u32,
        pixels_per_metre: Option<png::PixelDimensions>,
        srgb: bool,
        rgba: Vec<u8>,
    }
    fn decode(bytes: &[u8]) -> Image {
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        let mut rgba = vec![0; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut rgba).unwrap();
        assert_eq!(
            (frame.color_type, frame.bit_depth),
            (png::ColorType::Rgba, png::BitDepth::Eight)
        );
        rgba.truncate(frame.buffer_size());
        Image {
            width: frame.width,
            height: frame.height,
            pixels_per_metre: reader.info().pixel_dims,
            srgb: reader.info().srgb.is_some(),
            rgba,
        }
    }
    fn dark(p: &[u8]) -> bool {
        p[3] > 200 && p[0] < 100 && p[1] < 100 && p[2] < 100
    }
    fn dark_pixels(image: &Image) -> usize {
        image.rgba.chunks(4).filter(|p| dark(p)).count()
    }
    fn pixel(image: &Image, x: u32, y: u32) -> &[u8] {
        let at = ((y * image.width + x) * 4) as usize;
        &image.rgba[at..at + 4]
    }

    #[test]
    fn renders_each_page_at_the_resolution_with_its_physical_size() {
        let pages = render_pages(&[notation(true), notation(true)], 150).unwrap();
        assert_eq!(pages.len(), 2);
        for bytes in &pages {
            let image = decode(bytes);
            // 210 x 297 mm at 150 dpi.
            assert_eq!((image.width, image.height), (1240, 1754));
            let dims = image.pixels_per_metre.unwrap();
            assert_eq!(
                (dims.xppu, dims.yppu, dims.unit),
                (5906, 5906, png::Unit::Meter)
            );
            assert!(image.srgb);
            // The page is scaled to fill the image: the background reaches the far corner, and
            // the word placed near (700, 1000) on the 794 x 1123 page lands near (1093, 1562).
            assert_eq!(pixel(&image, 0, 0), &[255, 255, 255, 255]);
            assert_eq!(pixel(&image, 1239, 1753), &[255, 255, 255, 255]);
            assert!(
                (1500..1600).any(|y| (1050..1200).any(|x| dark(pixel(&image, x, y)))),
                "the scaled word is missing"
            );
            // The outlined words and the music glyph are drawn, not dropped.
            assert!(dark_pixels(&image) > 500);
        }
        let low = decode(&render_pages(&[notation(true)], 72).unwrap()[0]);
        assert_eq!((low.width, low.height), (595, 842));
    }

    #[test]
    fn leaves_the_background_transparent_and_stores_straight_alpha() {
        let image = decode(&render_pages(&[notation(false)], 96).unwrap()[0]);
        assert_eq!(image.rgba[3], 0);
        assert!(dark_pixels(&image) > 200);
        // Partly covered white edges stay white; premultiplied values would darken them.
        let white = page_with(
            210.0,
            297.0,
            "<text x='60' y='70' font-family='Noto Sans' font-size='40' fill='#fff'>TabPlayer</text>",
        );
        let image = decode(&render_pages(&[white], 96).unwrap()[0]);
        let edges: Vec<_> = image
            .rgba
            .chunks(4)
            .filter(|p| p[3] > 0 && p[3] < 200)
            .collect();
        assert!(!edges.is_empty());
        assert!(edges.iter().all(|p| p[..3].iter().all(|&c| c >= 250)));
    }

    #[test]
    fn refuses_resolutions_pages_and_text_it_cannot_render() {
        for dpi in [71, 601] {
            assert!(
                render_pages(&[notation(true)], dpi)
                    .unwrap_err()
                    .contains("72 to 600 dpi")
            );
        }
        assert!(render_pages(&[], 150).is_err());
        let huge = page_with(1000.0, 1000.0, BACKGROUND);
        assert!(
            render_pages(&[huge], 600)
                .unwrap_err()
                .contains("too large for that resolution")
        );
        // Each A4 page at 600 dpi fits alone; together they exceed the export budget before any render.
        let many = vec![notation(true); 50];
        assert!(
            render_pages(&many, 600)
                .unwrap_err()
                .contains("fewer pages")
        );
        let missing = page_with(
            210.0,
            297.0,
            "<text x='10' y='50' font-family='Noto Sans'>&#x10FFFF;</text>",
        );
        assert!(
            render_pages(&[missing], 150)
                .unwrap_err()
                .contains("could not be displayed with any font")
        );
        let mut remote = notation(true);
        remote.svg =
            "<svg xmlns='http://www.w3.org/2000/svg'><image href='file:///C:/secret.png'/></svg>"
                .into();
        assert!(render_pages(&[remote], 150).is_err());
    }
}
