//! Decodes an audio file with TabPlayer's Symphonia decoder and writes its stereo samples, scaled to `bits`-bit
//! integers, as little-endian 32-bit numbers. Prints the sample rate, channels and frames as JSON.
//!
//! `cargo run --release --example decode_audio -- <input> <bits> <output>`
use std::{env, fs};

fn main() {
    let args: Vec<String> = env::args().collect();
    let [_, input, bits, output] = &args[..] else {
        panic!("usage: decode_audio <input> <bits> <output>");
    };
    let bytes = fs::read(input).expect("read input");
    let hint = input.rsplit('.').next();
    let decoded = tabplayer_lib::audio::decode::decode_audio(&bytes, hint).expect("decode");
    let scale = (1i64 << (bits.parse::<u32>().expect("bits") - 1)) as f64;
    let samples: Vec<u8> = decoded
        .frames
        .iter()
        .flatten()
        .flat_map(|v| ((*v as f64 * scale).round() as i32).to_le_bytes())
        .collect();
    fs::write(output, samples).expect("write output");
    println!(
        r#"{{"sampleRate":{},"channels":{},"frames":{}}}"#,
        decoded.sample_rate,
        decoded.channels,
        decoded.frames.len()
    );
}
