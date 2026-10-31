//! FLAC encoding for exported audio. Each block of up to 4096 frames is stored as independent, left-side, right-side
//! or mid-side stereo, whichever leaves the smallest residual, and each channel with the fixed predictor that leaves
//! the smallest residual, Rice-coded in partitions. It is lossless: decoding gives back exactly the samples given.

/// Frames in every block but the last.
pub const BLOCK_FRAMES: usize = 4096;
/// The `fLaC` marker and the stream information block.
pub const HEADER_BYTES: usize = 42;
/// The most frames the stream information's 36-bit total can count: about 16 days at 48 kHz.
pub const MAX_FRAMES: u64 = (1 << 36) - 1;

/// A big-endian bit writer.
struct Bits {
    bytes: Vec<u8>,
    pending: u64,
    count: u32,
}
impl Bits {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            pending: 0,
            count: 0,
        }
    }
    /// Writes the low `bits` bits of `value`, at most 32.
    fn put(&mut self, value: u64, bits: u32) {
        if bits == 0 {
            return;
        }
        self.pending = (self.pending << bits) | (value & ((1u64 << bits) - 1));
        self.count += bits;
        while self.count >= 8 {
            self.count -= 8;
            self.bytes.push((self.pending >> self.count) as u8);
        }
        self.pending &= (1u64 << self.count) - 1;
    }
    /// Writes `value` as a `bits`-bit two's complement number.
    fn signed(&mut self, value: i64, bits: u32) {
        self.put(value as u64, bits);
    }
    /// Writes `zeros` zero bits and a one.
    fn unary(&mut self, mut zeros: u64) {
        while zeros >= 32 {
            self.put(0, 32);
            zeros -= 32;
        }
        self.put(1, zeros as u32 + 1);
    }
    fn align(&mut self) {
        if self.count > 0 {
            self.put(0, 8 - self.count);
        }
    }
}
fn crc8(bytes: &[u8]) -> u8 {
    let mut crc = 0u8;
    for byte in bytes {
        crc ^= byte;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x07
            } else {
                crc << 1
            };
        }
    }
    crc
}
fn crc16(bytes: &[u8]) -> u16 {
    let mut crc = 0u16;
    for byte in bytes {
        crc ^= (*byte as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x8005
            } else {
                crc << 1
            };
        }
    }
    crc
}
/// The residual of the fixed predictor of `order`, from sample `order` on.
fn residual(x: &[i64], order: usize) -> Vec<i64> {
    (order..x.len())
        .map(|i| match order {
            0 => x[i],
            1 => x[i] - x[i - 1],
            2 => x[i] - 2 * x[i - 1] + x[i - 2],
            3 => x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3],
            _ => x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4],
        })
        .collect()
}
/// The fixed predictor order, up to 4, that leaves the smallest residual, and that residual's size.
fn best_order(x: &[i64]) -> (usize, u64) {
    (0..=4.min(x.len().saturating_sub(1)))
        .map(|order| {
            let size = residual(x, order).iter().map(|r| r.unsigned_abs()).sum();
            (order, size)
        })
        .min_by_key(|&(_, size)| size)
        .unwrap_or((0, 0))
}
fn zigzag(r: i64) -> u64 {
    ((r << 1) ^ (r >> 63)) as u64
}
/// The Rice parameter for `count` values summing to `sum`, and the bits it is expected to take.
fn rice_parameter(sum: u64, count: u64) -> (u32, u64) {
    (0..=30)
        .map(|k| (k, count * (k as u64 + 1) + (sum >> k)))
        .min_by_key(|&(_, bits)| bits)
        .unwrap()
}
/// The partition order and Rice parameters expected to code `res` in the fewest bits, for a block of `n` samples
/// whose predictor of `order` left `res`, and the bits expected.
fn rice_plan(res: &[i64], order: usize, n: usize) -> (u32, Vec<u32>, u64) {
    let mut finest = 0;
    while finest < 8 && n % (1 << (finest + 1)) == 0 && n >> (finest + 1) > order {
        finest += 1;
    }
    // The sum and count of each finest partition; the first partition starts after the warm-up samples.
    let length = n >> finest;
    let mut parts: Vec<(u64, u64)> = (0..1usize << finest)
        .map(|i| {
            let start = (i * length).saturating_sub(order);
            let end = (i + 1) * length - order;
            let sum = res[start..end].iter().map(|r| zigzag(*r)).sum();
            (sum, (end - start) as u64)
        })
        .collect();
    let mut best: Option<(u32, Vec<u32>, u64)> = None;
    for partition_order in (0..=finest).rev() {
        let (ks, bits): (Vec<u32>, Vec<u64>) = parts
            .iter()
            .map(|&(sum, count)| rice_parameter(sum, count))
            .unzip();
        let total = bits.iter().sum::<u64>() + 5 * ks.len() as u64;
        if best.as_ref().is_none_or(|b| total < b.2) {
            best = Some((partition_order, ks, total));
        }
        parts = parts
            .chunks(2)
            .map(|pair| pair.iter().fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1)))
            .collect();
    }
    best.unwrap()
}
/// Writes one channel's subframe of `bps`-bit samples: constant, verbatim or fixed, whichever is smallest.
fn subframe(out: &mut Bits, x: &[i64], bps: u32) {
    if x.iter().all(|v| *v == x[0]) {
        out.put(0, 8);
        out.signed(x[0], bps);
        return;
    }
    let (order, _) = best_order(x);
    let res = residual(x, order);
    let (partition_order, ks, rice_bits) = rice_plan(&res, order, x.len());
    if order as u64 * bps as u64 + 6 + rice_bits >= x.len() as u64 * bps as u64 {
        out.put(0b0000_0010, 8);
        for v in x {
            out.signed(*v, bps);
        }
        return;
    }
    out.put((0b0000_1000 | order as u64) << 1, 8);
    for v in &x[..order] {
        out.signed(*v, bps);
    }
    // Rice coding with 5-bit parameters.
    out.put(0b01, 2);
    out.put(partition_order as u64, 4);
    let length = x.len() >> partition_order;
    for (i, k) in ks.iter().enumerate() {
        out.put(*k as u64, 5);
        let start = (i * length).saturating_sub(order);
        let end = (i + 1) * length - order;
        for r in &res[start..end] {
            let u = zigzag(*r);
            out.unary(u >> k);
            out.put(u, *k);
        }
    }
}
/// Writes `value` in FLAC's UTF-8-like coding of frame numbers.
fn frame_number(out: &mut Bits, value: u32) {
    if value < 0x80 {
        out.put(value as u64, 8);
        return;
    }
    let bytes = [0x800, 0x1_0000, 0x20_0000, 0x400_0000, 0x8000_0000u32]
        .iter()
        .position(|limit| value < *limit)
        .map_or(6, |i| i + 2) as u32;
    out.put(
        ((0xffu64 << (8 - bytes)) & 0xff) | (value as u64 >> (6 * (bytes - 1))),
        8,
    );
    for i in (0..bytes - 1).rev() {
        out.put(0x80 | ((value as u64 >> (6 * i)) & 0x3f), 8);
    }
}
/// One frame holding the `index`th block of stereo `bps`-bit samples at `rate` Hz, which must be 44.1 or 48 kHz
/// and 16 or 24 bits.
pub fn encode_frame(
    index: u32,
    rate: u32,
    bps: u32,
    left: &[i32],
    right: &[i32],
) -> Result<Vec<u8>, String> {
    let rate_code = match rate {
        44_100 => 0b1001,
        48_000 => 0b1010,
        _ => return Err(format!("FLAC export does not support {rate} Hz.")),
    };
    let depth_code = match bps {
        16 => 0b100,
        24 => 0b110,
        _ => return Err(format!("FLAC export does not support {bps}-bit samples.")),
    };
    let n = left.len();
    let l: Vec<i64> = left.iter().map(|v| *v as i64).collect();
    let r: Vec<i64> = right.iter().map(|v| *v as i64).collect();
    let side: Vec<i64> = l.iter().zip(&r).map(|(a, b)| a - b).collect();
    let mid: Vec<i64> = l.iter().zip(&r).map(|(a, b)| (a + b) >> 1).collect();
    let size = |x: &[i64]| best_order(x).1;
    let (ls, rs, ss, ms) = (size(&l), size(&r), size(&side), size(&mid));
    // Independent, left-side, right-side and mid-side stereo, with the side channel one bit wider.
    let (assignment, channels) = [
        (0b0001, ls + rs, [(&l, bps), (&r, bps)]),
        (0b1000, ls + ss, [(&l, bps), (&side, bps + 1)]),
        (0b1001, ss + rs, [(&side, bps + 1), (&r, bps)]),
        (0b1010, ms + ss, [(&mid, bps), (&side, bps + 1)]),
    ]
    .into_iter()
    .min_by_key(|(_, size, _)| *size)
    .map(|(assignment, _, channels)| (assignment, channels))
    .unwrap();
    let mut out = Bits::new();
    // Sync code, a reserved bit and the fixed-block-size strategy.
    out.put(0b1111_1111_1111_1000, 16);
    let size_code = if n == BLOCK_FRAMES { 0b1100 } else { 0b0111 };
    out.put(size_code, 4);
    out.put(rate_code, 4);
    out.put(assignment, 4);
    out.put(depth_code, 3);
    out.put(0, 1);
    frame_number(&mut out, index);
    if size_code == 0b0111 {
        out.put(n as u64 - 1, 16);
    }
    let crc = crc8(&out.bytes);
    out.put(crc as u64, 8);
    for (x, bits) in channels {
        subframe(&mut out, x, bits);
    }
    out.align();
    let crc = crc16(&out.bytes);
    out.put(crc as u64, 16);
    Ok(out.bytes)
}
/// The `fLaC` marker and stream information for `total` stereo frames of `bps`-bit samples at `rate` Hz, in frames
/// of `min_frame` to `max_frame` bytes. The MD5 signature is left unset, which marks it unknown.
pub fn stream_header(rate: u32, bps: u32, total: u64, min_frame: u32, max_frame: u32) -> Vec<u8> {
    let mut out = Bits::new();
    out.bytes.extend_from_slice(b"fLaC");
    // The last metadata block, of type stream information, 34 bytes long.
    out.put(1, 1);
    out.put(0, 7);
    out.put(34, 24);
    out.put(BLOCK_FRAMES as u64, 16);
    out.put(BLOCK_FRAMES as u64, 16);
    out.put(min_frame as u64, 24);
    out.put(max_frame as u64, 24);
    out.put(rate as u64, 20);
    out.put(1, 3);
    out.put(bps as u64 - 1, 5);
    out.put(total >> 32, 4);
    out.put(total & 0xffff_ffff, 32);
    out.bytes.extend_from_slice(&[0; 16]);
    out.bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::decode::decode_audio;
    /// A stream of `left` and `right` as one FLAC file.
    fn stream(rate: u32, bps: u32, left: &[i32], right: &[i32]) -> Vec<u8> {
        let frames: Vec<Vec<u8>> = left
            .chunks(BLOCK_FRAMES)
            .zip(right.chunks(BLOCK_FRAMES))
            .enumerate()
            .map(|(i, (l, r))| encode_frame(i as u32, rate, bps, l, r).unwrap())
            .collect();
        let sizes = frames.iter().map(|f| f.len() as u32);
        let mut bytes = stream_header(
            rate,
            bps,
            left.len() as u64,
            sizes.clone().min().unwrap_or(0),
            sizes.max().unwrap_or(0),
        );
        for frame in frames {
            bytes.extend_from_slice(&frame);
        }
        bytes
    }
    /// Decodes `bytes` with Symphonia's FLAC decoder and checks it gives back exactly `left` and `right`.
    fn round_trip(rate: u32, bps: u32, left: &[i32], right: &[i32]) -> usize {
        let bytes = stream(rate, bps, left, right);
        let decoded = decode_audio(&bytes, Some("flac")).unwrap();
        assert_eq!((decoded.sample_rate, decoded.channels), (rate, 2));
        assert_eq!(decoded.frames.len(), left.len());
        let scale = (1i64 << (bps - 1)) as f64;
        for (i, frame) in decoded.frames.iter().enumerate() {
            assert_eq!(
                [
                    (frame[0] as f64 * scale).round() as i32,
                    (frame[1] as f64 * scale).round() as i32
                ],
                [left[i], right[i]],
                "frame {i} at {bps} bits"
            );
        }
        bytes.len()
    }
    /// The channel assignment and each subframe type of the first frame of `bytes`, which must start a stream.
    fn first_frame_modes(bytes: &[u8]) -> (u8, u8) {
        let frame = &bytes[HEADER_BYTES..];
        // Sync and codes take four bytes, frame number 0 one, a short block's size two, then the CRC-8.
        let header = 5 + if frame[2] >> 4 == 0b0111 { 2 } else { 0 } + 1;
        (frame[3] >> 4, frame[header] >> 1)
    }
    #[test]
    fn decodes_to_exactly_the_samples_given_in_every_stereo_mode() {
        let mut seed = 0x1234_5678u32;
        let mut noise = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as i32
        };
        let mut seen = std::collections::BTreeSet::new();
        for (rate, bps) in [(44_100, 16), (48_000, 24), (48_000, 16), (44_100, 24)] {
            let top = (1i32 << (bps - 1)) - 1;
            let tone = |i: usize, hz: f64, amp: f64| {
                ((std::f64::consts::TAU * hz * i as f64 / rate as f64).sin() * amp * top as f64)
                    .round() as i32
            };
            // 10 000 frames: two whole blocks and a short last one.
            let n = 10_000;
            let same: Vec<i32> = (0..n).map(|i| tone(i, 220.0, 0.6)).collect();
            let wide: Vec<i32> = (0..n).map(|i| tone(i, 330.0, 0.9)).collect();
            let noisy: Vec<i32> = (0..n).map(|_| noise() >> (32 - bps)).collect();
            let other: Vec<i32> = (0..n).map(|_| noise() >> (32 - bps)).collect();
            let quiet: Vec<i32> = noisy.iter().map(|v| v >> (bps - 4)).collect();
            let extremes: Vec<i32> = (0..n)
                .map(|i| if i % 2 == 0 { top } else { -top - 1 })
                .collect();
            // Identical channels favour mid-side, unrelated ones independent stereo, and a silent channel a side
            // channel beside it; silence is constant, full-scale noise verbatim, and full-scale alternation overflows
            // a side channel that is not one bit wider.
            let silence = vec![0; n];
            for (left, right) in [
                (&same, &same),
                (&same, &wide),
                (&silence, &wide),
                (&wide, &silence),
                (&noisy, &other),
                (&quiet, &noisy),
                (&noisy, &quiet),
                (&noisy, &noisy.iter().map(|v| v / 2).collect::<Vec<_>>()),
                (
                    &extremes,
                    &extremes.iter().map(|v| -v - 1).collect::<Vec<_>>(),
                ),
                (&silence, &silence),
            ] {
                round_trip(rate, bps, left, right);
                seen.insert(first_frame_modes(&stream(rate, bps, left, right)));
            }
            // A stream shorter than one block, and one frame.
            round_trip(rate, bps, &same[..1025], &wide[..1025]);
            round_trip(rate, bps, &same[..1], &wide[..1]);
        }
        let assignments: std::collections::BTreeSet<u8> = seen.iter().map(|m| m.0).collect();
        let types: std::collections::BTreeSet<u8> = seen.iter().map(|m| m.1).collect();
        // Independent, left-side, right-side and mid-side stereo; constant, verbatim and fixed subframes.
        assert_eq!(
            assignments,
            [0b0001, 0b1000, 0b1001, 0b1010].into(),
            "{seen:?}"
        );
        assert!(types.contains(&0) && types.contains(&1), "{seen:?}");
        assert!(types.iter().any(|t| (8..=12).contains(t)), "{seen:?}");
    }
    #[test]
    fn compresses_music_and_silence_well_below_pcm() {
        let n = 48_000;
        let left: Vec<i32> = (0..n)
            .map(|i| ((i as f64 * 0.0577).sin() * 9_000.0 + (i as f64 * 0.31).sin() * 900.0) as i32)
            .collect();
        let right: Vec<i32> = left.iter().map(|v| v * 3 / 4).collect();
        let size = round_trip(48_000, 16, &left, &right);
        assert!(size < n * 4 / 2, "{size} bytes against {} of PCM", n * 4);
        let silent = round_trip(48_000, 16, &vec![0; n], &vec![0; n]);
        assert!(silent < 1_000, "{silent} bytes of silence");
    }
    #[test]
    fn writes_standard_headers_and_checksums() {
        let header = stream_header(48_000, 24, 123_456, 10, 20_000);
        assert_eq!(header.len(), HEADER_BYTES);
        assert_eq!(&header[..8], b"fLaC\x80\x00\x00\x22");
        assert_eq!(crc8(b"123456789"), 0xf4);
        assert_eq!(crc16(b"123456789"), 0xfee8);
        for (rate, bps) in [(96_000, 16), (44_100, 20)] {
            assert!(encode_frame(0, rate, bps, &[0], &[0]).is_err());
        }
        let mut bits = Bits::new();
        for value in [0, 0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x1_0000, 0x7fff_ffff] {
            frame_number(&mut bits, value);
        }
        // Numbers up to 0x10ffff are coded as UTF-8; larger ones extend the same scheme to six bytes.
        let mut expected: Vec<u8> = [0, 0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x1_0000]
            .iter()
            .flat_map(|v| char::from_u32(*v).unwrap().to_string().into_bytes())
            .collect();
        expected.extend_from_slice(&[0xfd, 0xbf, 0xbf, 0xbf, 0xbf, 0xbf]);
        assert_eq!(bits.bytes, expected);
    }
}
