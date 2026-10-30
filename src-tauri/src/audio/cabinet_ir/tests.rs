use super::*;

/// A reproducible sequence in -1..1.
pub fn noise(len: usize, seed: u32) -> Vec<f32> {
    let mut state = seed | 1;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as f32 / u32::MAX as f32 * 2.0 - 1.0
        })
        .collect()
}
/// A response shaped like a close-miked speaker: a click, then noise that is low-passed and dies away.
pub fn cabinet(rate: u32, seconds: f64, seed: u32) -> Vec<f32> {
    let len = (rate as f64 * seconds) as usize;
    let mut low = 0.0f32;
    let coefficient = 1.0 - (-std::f32::consts::TAU * 4_500.0 / rate as f32).exp();
    noise(len, seed)
        .iter()
        .enumerate()
        .map(|(n, v)| {
            low += coefficient * (v - low);
            let decay = (-(n as f32) / (0.12 * rate as f32 * seconds as f32 + 1.0)).exp();
            low * decay * 0.2 + if n == 0 { 0.6 } else { 0.0 }
        })
        .collect()
}
pub fn riff(tag: u16, channels: u16, bits: u16, rate: u32, data: &[u8]) -> Vec<u8> {
    let align = channels * bits / 8;
    let mut file = Vec::new();
    file.extend_from_slice(b"RIFF");
    file.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    file.extend_from_slice(b"WAVEfmt ");
    file.extend_from_slice(&16u32.to_le_bytes());
    file.extend_from_slice(&tag.to_le_bytes());
    file.extend_from_slice(&channels.to_le_bytes());
    file.extend_from_slice(&rate.to_le_bytes());
    file.extend_from_slice(&(rate * align as u32).to_le_bytes());
    file.extend_from_slice(&align.to_le_bytes());
    file.extend_from_slice(&bits.to_le_bytes());
    file.extend_from_slice(b"data");
    file.extend_from_slice(&(data.len() as u32).to_le_bytes());
    file.extend_from_slice(data);
    file
}
/// Samples as a WAV file in `bits` of integer, or 32-bit float when `bits` is 0.
pub fn wav_bytes(samples: &[f32], channels: u16, bits: u16, rate: u32) -> Vec<u8> {
    let mut data = Vec::new();
    for v in samples {
        match bits {
            16 => data.extend_from_slice(&((v * 32_767.0).round() as i16).to_le_bytes()),
            24 => data.extend_from_slice(&((v * 8_388_607.0).round() as i32).to_le_bytes()[..3]),
            32 => data
                .extend_from_slice(&((*v as f64 * 2_147_483_647.0).round() as i32).to_le_bytes()),
            _ => data.extend_from_slice(&v.to_le_bytes()),
        }
    }
    riff(
        if bits == 0 { 3 } else { 1 },
        channels,
        if bits == 0 { 32 } else { bits },
        rate,
        &data,
    )
}

#[test]
fn it_reads_every_supported_format_to_the_same_response() {
    let taps = cabinet(48_000, 0.3, 5);
    for bits in [16, 24, 32, 0] {
        let wav = parse_wav(&wav_bytes(&taps, 1, bits, 48_000)).unwrap();
        assert_eq!(
            (wav.rate, wav.channels, wav.mono.len()),
            (48_000, 1, taps.len())
        );
        let worst = wav
            .mono
            .iter()
            .zip(&taps)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max);
        assert!(
            worst < if bits == 16 { 1e-4 } else { 1e-6 },
            "{bits}-bit: {worst}"
        );
    }
}
#[test]
fn a_stereo_response_is_mixed_to_one_channel() {
    let left = cabinet(44_100, 0.2, 1);
    let right = cabinet(44_100, 0.2, 2);
    let mut both = Vec::new();
    for (l, r) in left.iter().zip(&right) {
        both.extend([*l, *r]);
    }
    let wav = parse_wav(&wav_bytes(&both, 2, 24, 44_100)).unwrap();
    assert_eq!(wav.channels, 2);
    for n in 0..left.len() {
        assert!((wav.mono[n] - (left[n] + right[n]) * 0.5).abs() < 1e-6);
    }
}
#[test]
fn it_reads_the_extensible_format_and_chunks_before_the_audio() {
    let taps = cabinet(48_000, 0.1, 3);
    let plain = wav_bytes(&taps, 1, 24, 48_000);
    // fmt as WAVE_FORMAT_EXTENSIBLE, after a LIST chunk of odd size.
    let data = &plain[44..];
    let mut file = b"RIFF\0\0\0\0WAVE".to_vec();
    file.extend_from_slice(b"LIST\x03\0\0\0abc\0");
    file.extend_from_slice(b"fmt \x28\0\0\0");
    file.extend_from_slice(&0xFFFEu16.to_le_bytes());
    file.extend_from_slice(&1u16.to_le_bytes());
    file.extend_from_slice(&48_000u32.to_le_bytes());
    file.extend_from_slice(&(48_000u32 * 3).to_le_bytes());
    file.extend_from_slice(&3u16.to_le_bytes());
    file.extend_from_slice(&24u16.to_le_bytes());
    file.extend_from_slice(&22u16.to_le_bytes());
    file.extend_from_slice(&24u16.to_le_bytes());
    file.extend_from_slice(&4u32.to_le_bytes());
    file.extend_from_slice(&1u16.to_le_bytes());
    file.extend_from_slice(&[0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71]);
    file.extend_from_slice(b"data");
    file.extend_from_slice(&(data.len() as u32).to_le_bytes());
    file.extend_from_slice(data);
    let wav = parse_wav(&file).unwrap();
    assert_eq!(wav.mono.len(), taps.len());
}
#[test]
fn it_refuses_what_is_not_a_cabinet_response_with_a_reason() {
    let good = wav_bytes(&cabinet(48_000, 0.2, 1), 1, 16, 48_000);
    let say = |bytes: &[u8]| {
        parse_wav(bytes)
            .err()
            .map(|p| p.message)
            .unwrap_or_default()
    };
    assert!(say(b"not a wav file at all").contains("not a WAV"));
    assert!(say(b"").contains("not a WAV"));
    let mut aiff = good.clone();
    aiff[8..12].copy_from_slice(b"AIFF");
    assert!(say(&aiff).contains("not a WAV"));
    let mut rf64 = good.clone();
    rf64[0..4].copy_from_slice(b"RF64");
    assert!(say(&rf64).contains("RF64"));
    assert!(!say(&wav_bytes(&[0.1; 100], 1, 0, 48_000)[..30]).is_empty());
    let mut short = b"RIFF\0\0\0\0WAVEfmt \x0a\0\0\0".to_vec();
    short.extend_from_slice(&[1, 0, 1, 0, 0x80, 0xbb, 0, 0, 0, 0]);
    short.extend_from_slice(b"data\x04\0\0\0abcd");
    assert!(say(&short).contains("damaged"));
    let eight = riff(1, 1, 8, 48_000, &[128; 100]);
    assert!(say(&eight).contains("8-bit"));
    let adpcm = riff(2, 1, 4, 48_000, &[0; 100]);
    assert!(say(&adpcm).contains("compressed"));
    let float64 = riff(3, 1, 64, 48_000, &[0; 800]);
    assert!(say(&float64).contains("64-bit float"));
    let surround = riff(1, 6, 16, 48_000, &[0; 1200]);
    assert!(say(&surround).contains("6 channels"));
    assert!(say(&riff(1, 1, 16, 400_000, &[0; 100])).contains("sample rate"));
    assert!(say(&riff(1, 1, 16, 4_000, &[0; 100])).contains("sample rate"));
    assert!(say(&riff(1, 1, 16, 48_000, &[])).contains("no audio"));
    let long = riff(1, 1, 16, 48_000, &vec![1u8; 48_000 * 2 * 3]);
    assert!(say(&long).contains("3.0 seconds long"));
    let nan = riff(3, 1, 32, 48_000, &f32::NAN.to_le_bytes().repeat(100));
    assert!(say(&nan).contains("not numbers"));
    let mut mismatched = good.clone();
    mismatched[32..34].copy_from_slice(&3u16.to_le_bytes());
    assert!(say(&mismatched).contains("inconsistent"));
    let mut nodata = good.clone();
    nodata[36..40].copy_from_slice(b"junk");
    assert!(say(&nodata).contains("no audio"));
}
#[test]
fn a_hostile_file_cannot_panic_or_allocate_much() {
    let good = wav_bytes(&cabinet(48_000, 0.2, 1), 1, 16, 48_000);
    // Sizes far past the end, or that wrap, and a short file.
    for size in [0xFFFF_FFFFu32, 0x8000_0000, 0xFFFF_FFFE, 0xFFFF_FFF0, 1, 3] {
        for at in [40, 16, 4] {
            let mut file = good.clone();
            file[at..at + 4].copy_from_slice(&size.to_le_bytes());
            let _ = parse_wav(&file);
        }
    }
    // A streaming recorder's data size reads as far as the file goes.
    let mut streaming = good.clone();
    streaming[40..44].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
    assert_eq!(parse_wav(&streaming).unwrap().mono.len(), 9600);
    // Every prefix, and a great many corrupted copies.
    for length in 0..good.len().min(200) {
        let _ = parse_wav(&good[..length]);
    }
    let mut state = 12345u32;
    for _ in 0..4000 {
        let mut file = good[..(60 + state as usize % 400)].to_vec();
        for _ in 0..4 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let at = state as usize % file.len();
            file[at] = (state >> 24) as u8;
        }
        let _ = parse_wav(&file);
    }
    // A thousand empty chunks.
    let mut chunks = good[..12].to_vec();
    for _ in 0..1000 {
        chunks.extend_from_slice(b"junk\0\0\0\0");
    }
    assert!(parse_wav(&chunks).is_err());
}
#[test]
fn it_resamples_without_changing_the_sound() {
    let rate = 44_100u32;
    let tone: Vec<f32> = (0..rate)
        .map(|n| (std::f64::consts::TAU * 1_000.0 * n as f64 / rate as f64).sin() as f32)
        .collect();
    for target in [48_000u32, 96_000, 32_000, 22_050] {
        let out = resample(&tone, rate, target);
        assert_eq!(out.len(), (target as f64).ceil() as usize);
        let worst = out[2000..out.len() - 2000]
            .iter()
            .enumerate()
            .map(|(n, v)| {
                let n = n + 2000;
                let want = (std::f64::consts::TAU * 1_000.0 * n as f64 / target as f64).sin();
                (*v as f64 - want).abs()
            })
            .fold(0.0, f64::max);
        assert!(worst < 2e-3, "{rate} to {target}: {worst}");
    }
    // A tone above the lower rate's Nyquist is removed rather than folded back.
    let high: Vec<f32> = (0..rate)
        .map(|n| (std::f64::consts::TAU * 15_000.0 * n as f64 / rate as f64).sin() as f32)
        .collect();
    let out = resample(&high, rate, 22_050);
    let peak = out[2000..out.len() - 2000]
        .iter()
        .fold(0.0f32, |p, v| p.max(v.abs()));
    assert!(peak < 1e-2, "folded back at {peak}");
}
#[test]
fn the_taps_are_trimmed_faded_and_set_to_the_level_of_the_built_in_cabinets() {
    let rate = 48_000;
    // Silence before the onset and after the tail goes.
    let mut padded = vec![0.0f32; 700];
    padded.extend(cabinet(rate, 0.2, 7));
    padded.extend(vec![0.0f32; 20_000]);
    let wav = parse_wav(&wav_bytes(&padded, 1, 24, rate)).unwrap();
    let taps = prepare_taps(&wav, rate).unwrap();
    let peak = taps.iter().fold(0.0f32, |p, v| p.max(v.abs()));
    assert!(taps[0].abs() > 0.1 * peak);
    assert!((7_000..9_700).contains(&taps.len()), "{} taps", taps.len());
    assert!(taps.last().unwrap().abs() < peak * 0.01);
    // Its gain across the midrange is 1, whatever level the file was recorded at.
    for gain in [1.0f32, 0.01, 0.0003] {
        let quiet: Vec<f32> = padded.iter().map(|v| v * gain).collect();
        let wav = parse_wav(&wav_bytes(&quiet, 1, 0, rate)).unwrap();
        let (band, _) = band_gain(&prepare_taps(&wav, rate).unwrap(), rate);
        assert!((band - 1.0).abs() < 0.02, "gain {gain}: band {band}");
    }
}
#[test]
fn a_long_response_is_cut_with_a_fade_and_a_silent_one_is_refused() {
    let rate = 48_000;
    let long = cabinet(rate, 1.8, 9);
    let wav = parse_wav(&wav_bytes(&long, 1, 16, rate)).unwrap();
    assert!(was_cut(&wav, rate));
    let taps = prepare_taps(&wav, rate).unwrap();
    assert_eq!(taps.len(), max_taps(rate));
    let peak = taps.iter().fold(0.0f32, |p, v| p.max(v.abs()));
    assert!(
        taps[taps.len() - 10..]
            .iter()
            .all(|v| v.abs() < peak * 0.001)
    );
    let silent = parse_wav(&wav_bytes(&vec![0.0; 9600], 1, 16, rate)).unwrap();
    assert!(
        prepare_taps(&silent, rate)
            .unwrap_err()
            .message
            .contains("silent")
    );
    let faint = parse_wav(&wav_bytes(&vec![5e-5; 9600], 1, 0, rate)).unwrap();
    assert!(
        prepare_taps(&faint, rate)
            .unwrap_err()
            .message
            .contains("silent")
    );
    // Constant offset only: nothing in the guitar's band.
    let offset = parse_wav(&wav_bytes(&vec![0.5; 9600], 1, 0, rate)).unwrap();
    assert!(
        prepare_taps(&offset, rate)
            .unwrap_err()
            .message
            .contains("400 Hz")
    );
}
#[test]
fn a_response_is_made_at_each_usual_rate_from_any_source_rate() {
    for source in [44_100u32, 48_000, 96_000, 22_050] {
        let wav = parse_wav(&wav_bytes(&cabinet(source, 0.5, 4), 1, 24, source)).unwrap();
        for rate in [44_100u32, 48_000, 96_000, 192_000] {
            let taps = prepare_taps(&wav, rate).unwrap();
            assert!(
                taps.len() > rate as usize / 8 && taps.len() <= max_taps(rate),
                "{source} to {rate}: {}",
                taps.len()
            );
            IrKernel::new(&taps, rate).unwrap();
        }
    }
}

/// Moves a file's modification time on, as any real change does, however fast the test wrote it.
fn changed(path: &Path) {
    let file = std::fs::File::options().write(true).open(path).unwrap();
    let later = SystemTime::now() + std::time::Duration::from_secs(5);
    let at = file.metadata().unwrap().modified().unwrap().max(later);
    file.set_modified(at + std::time::Duration::from_secs(1))
        .unwrap();
}
fn library() -> (tempfile::TempDir, IrLibrary) {
    let directory = tempfile::tempdir().unwrap();
    let library = IrLibrary::new(directory.path().join("cabinet-irs"));
    (directory, library)
}
#[test]
fn the_library_copies_names_lists_and_removes_a_response() {
    let (_directory, library) = library();
    assert!(library.list().is_empty());
    let file = wav_bytes(&cabinet(44_100, 0.4, 1), 1, 24, 44_100);
    let entry = library.import_bytes(&file, "Mesa 4x12 SM57.wav").unwrap();
    assert!(valid_id(&entry.id));
    assert_eq!(entry.name, "Mesa 4x12 SM57");
    assert_eq!((entry.sample_rate, entry.channels), (44_100, 1));
    assert!((entry.duration_ms - 400.0).abs() < 1.0);
    // The same file is the same response, and importing it again changes nothing.
    let again = library.import_bytes(&file, "renamed.wav").unwrap();
    assert_eq!(
        (again.id.clone(), again.name.clone()),
        (entry.id.clone(), entry.name.clone())
    );
    assert_eq!(library.list().len(), 1);
    // The library holds a copy of the audio, byte for byte.
    assert_eq!(std::fs::read(library.wav_path(&entry.id)).unwrap(), file);
    let other = library
        .import_bytes(&wav_bytes(&cabinet(48_000, 0.3, 2), 2, 16, 48_000), "B.wav")
        .unwrap();
    assert_ne!(other.id, entry.id);
    let names: Vec<_> = library.list().into_iter().map(|e| e.name).collect();
    assert_eq!(names, ["B", "Mesa 4x12 SM57"]);
    let status = library.status(&[entry.id.clone(), "0".repeat(32), "bad".into()]);
    assert_eq!(status[0].state, "ready");
    assert_eq!(status[1].state, "missing");
    assert_eq!(status[2].state, "missing");
    library.remove(&entry.id).unwrap();
    assert_eq!(library.list().len(), 1);
    assert_eq!(library.status(&[entry.id.clone()])[0].state, "missing");
    assert!(library.kernel(&entry.id, 48_000).is_err());
    library.remove(&entry.id).unwrap();
    assert!(library.remove("../etc").is_err());
}
#[test]
fn the_library_refuses_what_is_not_acceptable_and_stores_nothing() {
    let (_directory, library) = library();
    for bytes in [
        b"RIFF....nope".to_vec(),
        wav_bytes(&vec![0.0; 4800], 1, 16, 48_000),
        wav_bytes(&cabinet(48_000, 2.5, 1), 1, 16, 48_000),
    ] {
        assert_eq!(
            library.import_bytes(&bytes, "x.wav").unwrap_err().kind,
            ProblemKind::Refused
        );
    }
    assert!(library.list().is_empty());
    assert!(
        !library.directory.exists()
            || std::fs::read_dir(&library.directory)
                .unwrap()
                .next()
                .is_none()
    );
}
#[test]
fn a_file_larger_than_the_limit_is_refused_without_being_read() {
    let (directory, library) = library();
    let path = directory.path().join("big.wav");
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    assert!(
        library
            .import_path(&path)
            .unwrap_err()
            .message
            .contains("larger than 4 MB")
    );
    assert_eq!(
        library
            .import_path(&directory.path().join("none.wav"))
            .unwrap_err()
            .kind,
        ProblemKind::Missing
    );
    assert!(
        library
            .import_path(directory.path())
            .unwrap_err()
            .message
            .contains("not a file")
    );
}
#[test]
fn a_damaged_or_changed_file_is_unreadable_and_never_an_error_for_the_chain() {
    let (_directory, library) = library();
    let entry = library
        .import_bytes(&wav_bytes(&cabinet(48_000, 0.3, 1), 1, 16, 48_000), "A.wav")
        .unwrap();
    assert!(library.kernel(&entry.id, 48_000).is_ok());
    let path = library.wav_path(&entry.id);
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[100] ^= 0x55;
    std::fs::write(&path, &bytes).unwrap();
    changed(&path);
    // A fresh rate must read the file, and it no longer matches. So must the rate already designed: a kernel made
    // from the file as it was is not played once the file is not.
    let problem = library.kernel(&entry.id, 96_000).err().unwrap();
    assert_eq!(problem.kind, ProblemKind::Unreadable);
    assert_eq!(
        library.kernel(&entry.id, 48_000).err().unwrap().kind,
        ProblemKind::Unreadable
    );
    assert_eq!(library.status(&[entry.id.clone()])[0].state, "unreadable");
    std::fs::write(&path, b"junk").unwrap();
    changed(&path);
    assert_eq!(library.status(&[entry.id.clone()])[0].state, "unreadable");
    // A lost description is made again from the audio.
    std::fs::remove_file(library.meta_path(&entry.id)).unwrap();
    std::fs::write(&path, wav_bytes(&cabinet(48_000, 0.3, 1), 1, 16, 48_000)).unwrap();
    assert_eq!(library.list().len(), 1);
}
#[test]
fn a_kernel_is_designed_once_per_rate_and_shared() {
    let (_directory, library) = library();
    let entry = library
        .import_bytes(&wav_bytes(&cabinet(44_100, 0.5, 1), 1, 24, 44_100), "A.wav")
        .unwrap();
    let a = library.kernel(&entry.id, 48_000).unwrap();
    let b = library.kernel(&entry.id, 48_000).unwrap();
    assert!(Arc::ptr_eq(&a, &b));
    let c = library.kernel(&entry.id, 44_100).unwrap();
    assert_eq!((a.rate(), c.rate()), (48_000, 44_100));
    assert_ne!(a.serial(), c.serial());
}
#[test]
fn names_are_made_safe() {
    assert_eq!(display_name("C:/x/y/My Cab.wav"), "My Cab");
    assert_eq!(display_name("\u{7}\u{0}.wav"), "Cabinet IR");
    assert_eq!(
        display_name(&format!("{}.wav", "é".repeat(100)))
            .chars()
            .count(),
        64
    );
    assert_eq!(display_name("  spaced  .wav"), "spaced");
}
#[test]
fn a_name_keeps_its_dots_and_a_file_imported_by_path_is_named_once() {
    let (directory, library) = library();
    assert_eq!(display_name("V30 SM57 0.5in cap.wav"), "V30 SM57 0.5in cap");
    assert_eq!(display_name("Dr. Z 1.2.wav"), "Dr. Z 1.2");
    let path = directory.path().join("V30 SM57 0.5in cap.wav");
    std::fs::write(&path, wav_bytes(&cabinet(48_000, 0.3, 1), 1, 16, 48_000)).unwrap();
    let entry = library.import_path(&path).unwrap();
    assert_eq!(entry.name, "V30 SM57 0.5in cap");
    assert_eq!(library.list()[0].name, "V30 SM57 0.5in cap");
}
#[test]
fn a_name_holds_only_what_a_document_accepts() {
    // The byte-order mark and the two non-characters are refused by a document's rules, anywhere in a name.
    assert_eq!(
        display_name("\u{FEFF}Mesa\u{FFFE} 4x12\u{FFFF}\u{FEFF}.wav"),
        "Mesa 4x12"
    );
    assert_eq!(display_name("\u{FEFF}\u{FFFF}.wav"), "Cabinet IR");
    for name in [
        "a\u{FEFF}b.wav",
        "\u{FEFF}.wav",
        "tab\there.wav",
        "日本語.wav",
    ] {
        let shown = display_name(name);
        assert!(shown.chars().all(allowed_in_name), "{shown:?}");
    }
}
#[test]
fn a_damaged_copy_is_put_right_by_importing_the_file_again() {
    let (_directory, library) = library();
    let file = wav_bytes(&cabinet(48_000, 0.3, 1), 1, 16, 48_000);
    let entry = library.import_bytes(&file, "A.wav").unwrap();
    assert!(library.kernel(&entry.id, 48_000).is_ok());
    let path = library.wav_path(&entry.id);
    let mut damaged = file.clone();
    damaged[100] ^= 0x55;
    std::fs::write(&path, &damaged).unwrap();
    changed(&path);
    assert_eq!(library.status(&[entry.id.clone()])[0].state, "unreadable");
    // The description is still there, so the library lists it; importing the original restores the audio.
    assert_eq!(library.list().len(), 1);
    let again = library.import_bytes(&file, "renamed.wav").unwrap();
    assert_eq!(
        (again.id.clone(), again.name.as_str()),
        (entry.id.clone(), "A")
    );
    assert_eq!(std::fs::read(&path).unwrap(), file);
    assert_eq!(library.status(&[entry.id.clone()])[0].state, "ready");
    assert!(library.kernel(&entry.id, 48_000).is_ok());
    // A lost description is written again, with the name of this import.
    std::fs::remove_file(library.meta_path(&entry.id)).unwrap();
    let again = library.import_bytes(&file, "Fresh name.wav").unwrap();
    assert_eq!(again.name, "Fresh name");
    assert_eq!(library.list()[0].name, "Fresh name");
    // A copy that has been deleted is copied back.
    std::fs::remove_file(&path).unwrap();
    library.import_bytes(&file, "x.wav").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), file);
}
#[test]
fn a_cached_kernel_is_checked_against_the_file_and_a_damaged_file_is_read_once() {
    let (_directory, library) = library();
    let file = wav_bytes(&cabinet(48_000, 0.3, 1), 1, 16, 48_000);
    let entry = library.import_bytes(&file, "A.wav").unwrap();
    let first = library.kernel(&entry.id, 48_000).unwrap();
    assert!(Arc::ptr_eq(
        &first,
        &library.kernel(&entry.id, 48_000).unwrap()
    ));
    let path = library.wav_path(&entry.id);
    // Removed: no kernel is played from what was designed.
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        library.kernel(&entry.id, 48_000).err().unwrap().kind,
        ProblemKind::Missing
    );
    // Damaged: the finding is kept while the file stays as it is, so a prepare does not read it again.
    let mut damaged = file.clone();
    damaged[100] ^= 0x55;
    std::fs::write(&path, &damaged).unwrap();
    changed(&path);
    assert!(library.kernel(&entry.id, 48_000).is_err());
    assert_eq!(library.cache().len(), 1);
    assert!(library.cache()[0].outcome.is_err());
    // The original put back is read again, and works.
    std::fs::write(&path, &file).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(SystemTime::now() + std::time::Duration::from_secs(9))
        .unwrap();
    assert!(library.kernel(&entry.id, 48_000).is_ok());
    assert_eq!(library.cache().len(), 1);
}
#[test]
fn status_is_asked_at_the_rate_the_sound_card_plays_at() {
    let (_directory, library) = library();
    let entry = library
        .import_bytes(&wav_bytes(&cabinet(48_000, 0.3, 1), 1, 16, 48_000), "A.wav")
        .unwrap();
    assert_eq!(library.device_rate(), None);
    assert_eq!(library.status(&[entry.id.clone()])[0].state, "ready");
    library.kernel(&entry.id, 44_100).unwrap();
    assert_eq!(library.device_rate(), Some(44_100));
    assert_eq!(library.status(&[entry.id.clone()])[0].state, "ready");
    // A problem that arises only at the sound card's rate says which rate.
    let problem = at_rate(IrProblem::refused("Nothing."), 96_000);
    assert_eq!(problem.message, "At 96000 Hz: Nothing.");
    assert_eq!(problem.kind, ProblemKind::Refused);
}
#[test]
fn a_cut_is_counted_from_the_onset_and_no_tap_is_subnormal() {
    let rate = 48_000;
    // A long lead-in of silence and a response of half a second: the response is not cut.
    let mut padded = vec![0.0f32; 60_000];
    padded.extend(cabinet(rate, 0.5, 3));
    let wav = parse_wav(&wav_bytes(&padded, 1, 24, rate)).unwrap();
    assert!(!was_cut(&wav, rate));
    let taps = prepare_taps(&wav, rate).unwrap();
    assert!(taps.len() < rate as usize / 2 + 100 && taps[0].abs() > 0.0);
    // A response of 1.6 seconds, however it is padded, is.
    let mut long = vec![0.0f32; 4_000];
    long.extend(cabinet(rate, 1.6, 4));
    assert!(was_cut(
        &parse_wav(&wav_bytes(&long, 1, 24, rate)).unwrap(),
        rate
    ));
    // Nothing is smaller than anything that could be heard.
    assert!(taps.iter().all(|v| *v == 0.0 || v.abs() >= TAP_FLOOR));
}
#[test]
fn the_resampler_stops_just_under_the_lower_rates_nyquist_going_up_as_well_as_down() {
    let rate = 44_100u32;
    let peak_of = |hz: f64| {
        let tone: Vec<f32> = (0..rate)
            .map(|n| (std::f64::consts::TAU * hz * n as f64 / rate as f64).sin() as f32)
            .collect();
        let out = resample(&tone, rate, 96_000);
        out[2000..out.len() - 2000]
            .iter()
            .fold(0.0f32, |p, v| p.max(v.abs()))
    };
    // Half the level is at the cutoff, 97% of the source's Nyquist frequency of 22.05 kHz, 21.39 kHz; a source with
    // the cutoff at its Nyquist frequency would pass it nearly whole.
    let at_cutoff = peak_of(21_388.0);
    assert!((0.35..0.65).contains(&at_cutoff), "{at_cutoff}");
    assert!(peak_of(20_500.0) > at_cutoff && peak_of(22_000.0) < at_cutoff);
    assert!((peak_of(10_000.0) - 1.0).abs() < 0.01);
}
#[test]
fn a_description_is_read_with_a_bound() {
    let (_directory, library) = library();
    let entry = library
        .import_bytes(&wav_bytes(&cabinet(48_000, 0.3, 1), 1, 16, 48_000), "A.wav")
        .unwrap();
    assert!(library.sidecar(&entry.id).is_some());
    // A description longer than it can be is not read, and the response is described again from its audio.
    let mut huge = std::fs::read(library.meta_path(&entry.id)).unwrap();
    huge.resize(SIDECAR_LIMIT as usize + 1, b' ');
    std::fs::write(library.meta_path(&entry.id), &huge).unwrap();
    assert!(library.sidecar(&entry.id).is_none());
    assert_eq!(library.list()[0].name, "Cabinet IR");
    assert!(read_small(&library.wav_path(&entry.id), 10).is_none());
    assert!(read_small(&library.directory.join("nothing"), 10).is_none());
}
