use serde::{Deserialize, Serialize};

/// Native track delay storage is bounded independently of score tempo and playback speed.
pub const MAX_TRACK_DELAY_SECONDS: f64 = 16.0;

macro_rules! block {
    ($name:ident { $($field:ident:$kind:ty=$value:expr),* $(,)? }) => {
        #[derive(Clone,Debug,PartialEq,Serialize,Deserialize)]
        #[serde(rename_all="camelCase",deny_unknown_fields)]
        pub struct $name {pub enabled:bool,$(pub $field:$kind),*}
        impl Default for $name {fn default()->Self {Self {enabled:false,$($field:$value),*}}}
    };
    // Fields added later default to 0 and are not written while 0, so blocks saved before them load and save unchanged.
    ($name:ident { $($field:ident:$kind:ty=$value:expr),* $(,)? } later { $($later:ident),* $(,)? }) => {
        #[derive(Clone,Debug,PartialEq,Serialize,Deserialize)]
        #[serde(rename_all="camelCase",deny_unknown_fields)]
        pub struct $name {pub enabled:bool,$(pub $field:$kind,)* $(#[serde(default,skip_serializing_if="is_zero")] pub $later:f64,)*}
        impl Default for $name {fn default()->Self {Self {enabled:false,$($field:$value,)* $($later:0.0,)*}}}
    };
}
fn is_zero(value: &f64) -> bool {
    *value == 0.0
}
block!(Gate {
    threshold_db: f64 = -60.0,
    release_ms: f64 = 100.0
});
block!(Compressor {
    threshold_db: f64 = -18.0,
    ratio: f64 = 4.0,
    attack_ms: f64 = 10.0,
    release_ms: f64 = 100.0,
    makeup_db: f64 = 0.0
});
block!(Amp {
    model: String = "clean".into(),
    drive: f64 = 0.1,
    gain_db: f64 = 0.0
} later {
    // The tone stack after the preamp, in dB: a bass shelf, a mid peak, a treble shelf and a presence peak.
    bass_db,
    mid_db,
    treble_db,
    presence_db
});
block!(Cabinet {
    model: String = "open".into()
});
block!(Eq {
    low_db: f64 = 0.0,
    mid_db: f64 = 0.0,
    high_db: f64 = 0.0,
    mid_hz: f64 = 1000.0
});
block!(Chorus {
    rate_hz: f64 = 1.0,
    depth_ms: f64 = 5.0,
    mix: f64 = 0.15
} later {
    // Quarter notes per cycle when the rate follows the tempo; 0 for the free rate.
    sync_quarter_notes
});
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wah {
    pub enabled: bool,
    /// Classic, vintage, wide or bass. Sounds saved before the other models load as the classic, which is not written.
    #[serde(default = "classic_wah", skip_serializing_if = "is_classic_wah")]
    pub model: String,
    pub mode: String,
    pub position: f64,
    pub resonance: f64,
    pub sensitivity: f64,
    pub mix: f64,
}
impl Default for Wah {
    fn default() -> Self {
        Self {
            enabled: false,
            model: classic_wah(),
            mode: "manual".into(),
            position: 0.5,
            resonance: 0.5,
            sensitivity: 0.5,
            mix: 1.0,
        }
    }
}
fn classic_wah() -> String {
    "classic".into()
}
fn is_classic_wah(model: &String) -> bool {
    model == "classic"
}
block!(Octaver {
    octave_down: f64 = 0.5,
    two_octaves_down: f64 = 0.0,
    direct: f64 = 1.0
});
block!(Pitch {
    semitones: f64 = 12.0,
    mix: f64 = 1.0
});
block!(Drive {
    model: String = "overdrive".into(),
    drive: f64 = 0.5,
    tone: f64 = 0.5,
    level_db: f64 = 0.0
});
block!(Microphone {
    placement: String = "standard".into(),
    output: String = "stereo".into()
});
block!(GraphicEq {
    gains_db: [f64; 10] = [0.0; 10],
    level_db: f64 = 0.0
});
/// The graphic EQ's band centres in hertz, an octave apart, and their bandwidth of one octave.
const GRAPHIC_EQ_BANDS: [f64; 10] = [
    31.5, 63.0, 125.0, 250.0, 500.0, 1_000.0, 2_000.0, 4_000.0, 8_000.0, 16_000.0,
];
const GRAPHIC_EQ_Q: f64 = std::f64::consts::SQRT_2;
block!(Flanger {
    rate_hz: f64 = 0.25,
    depth_ms: f64 = 2.0,
    feedback: f64 = 0.5,
    mix: f64 = 0.5
} later {
    // Quarter notes per cycle when the rate follows the tempo; 0 for the free rate.
    sync_quarter_notes
});
block!(Phaser {
    rate_hz: f64 = 0.5,
    depth: f64 = 0.7,
    feedback: f64 = 0.3,
    stages: u32 = 4,
    mix: f64 = 0.5
} later {
    // Quarter notes per cycle when the rate follows the tempo; 0 for the free rate.
    sync_quarter_notes
});
block!(Tremolo {
    rate_hz: f64 = 5.0,
    depth: f64 = 0.5,
    shape: String = "sine".into()
} later {
    // Quarter notes per cycle when the rate follows the tempo; 0 for the free rate.
    sync_quarter_notes
});
block!(Vibrato {
    rate_hz: f64 = 5.0,
    depth_cents: f64 = 20.0
} later {
    // Quarter notes per cycle when the rate follows the tempo; 0 for the free rate.
    sync_quarter_notes
});
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Delay {
    pub enabled: bool,
    /// Digital, tape or analog. Sounds saved before the other models load as digital, which is not written.
    #[serde(default = "digital_model", skip_serializing_if = "is_digital_model")]
    pub model: String,
    pub quarter_notes: f64,
    pub feedback: f64,
    pub mix: f64,
}
impl Default for Delay {
    fn default() -> Self {
        Self {
            enabled: false,
            model: digital_model(),
            quarter_notes: 1.0,
            feedback: 0.25,
            mix: 0.15,
        }
    }
}
fn digital_model() -> String {
    "digital".into()
}
fn is_digital_model(model: &String) -> bool {
    model == "digital"
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reverb {
    pub enabled: bool,
    /// Room, hall, plate or spring. Sounds saved before the other models load as the room, which is not written.
    #[serde(default = "room_model", skip_serializing_if = "is_room_model")]
    pub model: String,
    pub room: f64,
    pub damping: f64,
    pub mix: f64,
}
impl Default for Reverb {
    fn default() -> Self {
        Self {
            enabled: false,
            model: room_model(),
            room: 0.5,
            damping: 0.5,
            mix: 0.12,
        }
    }
}
fn room_model() -> String {
    "room".into()
}
fn is_room_model(model: &String) -> bool {
    model == "room"
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FxSettings {
    pub gate: Gate,
    pub compressor: Compressor,
    pub amp: Amp,
    pub cabinet: Cabinet,
    pub eq: Eq,
    pub chorus: Chorus,
    pub delay: Delay,
    pub reverb: Reverb,
    // Later blocks are omitted while untouched, so sounds saved before them load and serialize unchanged.
    #[serde(default, skip_serializing_if = "untouched")]
    pub vibrato: Vibrato,
    #[serde(default, skip_serializing_if = "untouched")]
    pub phaser: Phaser,
    #[serde(default, skip_serializing_if = "untouched")]
    pub flanger: Flanger,
    #[serde(default, skip_serializing_if = "untouched")]
    pub tremolo: Tremolo,
    #[serde(default, skip_serializing_if = "untouched")]
    pub wah: Wah,
    #[serde(default, skip_serializing_if = "untouched")]
    pub octaver: Octaver,
    #[serde(default, skip_serializing_if = "untouched")]
    pub pitch: Pitch,
    #[serde(default, skip_serializing_if = "untouched")]
    pub drive: Drive,
    #[serde(default, skip_serializing_if = "untouched")]
    pub microphone: Microphone,
    #[serde(default, skip_serializing_if = "untouched")]
    pub graphic_eq: GraphicEq,
    /// Every block's name once, in the order the signal passes through them; empty for the default order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub order: Vec<String>,
    /// A second pedalboard the signal passes through after this one, so any pedal can play twice with its own
    /// settings. It holds no board of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub second: Option<Box<FxSettings>>,
}
fn untouched<T: Default + PartialEq>(value: &T) -> bool {
    *value == T::default()
}
/// The vibrato delay swing in frames for a depth in cents at a rate in hertz: a delay swinging by ±a seconds at
/// ω rad/s bends pitch by 1 ± aω.
fn vibrato_swing(cents: f64, rate_hz: f64, rate: f64) -> f64 {
    (2f64.powf(cents / 1200.0) - 2f64.powf(-cents / 1200.0))
        / 2.0
        / (std::f64::consts::TAU * rate_hz)
        * rate
}
/// The amp's tone stack: a low shelf at 100 Hz, a mid peak at 650 Hz, a high shelf at 2.5 kHz and a presence peak
/// at 4.5 kHz.
const AMP_TONE: [f64; 4] = [100.0, 650.0, 2500.0, 4500.0];
/// The amp's tone stack gains in dB, in the order of `AMP_TONE`.
fn amp_tone(amp: &Amp) -> [f64; 4] {
    [amp.bass_db, amp.mid_db, amp.treble_db, amp.presence_db]
}
/// Cycle lengths in quarter notes that a modulation rate can follow: the delay's divisions, then two and four whole
/// notes for slow sweeps.
const MODULATION_DIVISIONS: [f64; 12] = [
    0.125,
    0.25,
    1.0 / 3.0,
    0.5,
    2.0 / 3.0,
    0.75,
    1.0,
    1.5,
    2.0,
    4.0,
    8.0,
    16.0,
];
/// A modulation block's rate in hertz: the free rate, or one cycle per `sync` quarter notes at `bpm`, kept within
/// the block's range.
fn modulation_hz(rate_hz: f64, sync: f64, bpm: f64, low: f64, high: f64) -> f64 {
    if sync == 0.0 {
        rate_hz
    } else {
        (bpm / 60.0 / sync).clamp(low, high)
    }
}
/// Moves a delay swing toward its target by at most 0.03 frames a frame, a pitch bend under half a semitone.
fn slew(current: f64, target: f64) -> f64 {
    current + (target - current).clamp(-0.03, 0.03)
}
const WAH_MODELS: [&str; 4] = ["classic", "vintage", "wide", "bass"];
/// A wah model's sweep from heel to toe in Hz, and its peak's damping as `1 / (base + span × resonance)`.
fn wah_model(model: &str) -> (f64, f64, f64, f64) {
    match model {
        // A vintage pedal's narrower, vocal sweep with a sharper peak.
        "vintage" => (450.0, 1_600.0, 3.0, 10.0),
        // A modern pedal's wide sweep with a broader peak.
        "wide" => (250.0, 3_500.0, 1.5, 6.0),
        // A bass wah's low sweep.
        "bass" => (120.0, 1_000.0, 2.0, 6.0),
        _ => (350.0, 2_200.0, 2.0, 8.0),
    }
}
/// The wah's pedal position, from heel (0) to toe (1): the manual setting, or the playing level in auto mode.
fn wah_target(wah: &Wah, envelope: f64) -> f64 {
    if wah.mode == "auto" {
        // A loud pickup peaks near -20 dBFS here. The heel sits at -30 dBFS at sensitivity 0 and at -70 dBFS at
        // sensitivity 1, and 36 dB louder reaches the toe, so a loud note opens most of the way at the default.
        let floor = -30.0 - 40.0 * wah.sensitivity;
        ((20.0 * envelope.max(1e-9).log10() - floor) / 36.0).clamp(0.0, 1.0)
    } else {
        wah.position
    }
}
/// A loud pickup's peak, at which the drive pedal keeps its output level whatever its setting.
const DRIVE_REFERENCE: f64 = 0.1;
/// The fuzz offsets its input by this share of the playing level, so its clipping is lopsided at any level and
/// adds even harmonics, as a fuzz's biased transistor does.
const FUZZ_BIAS: f64 = 0.25;
/// The drive pedal's gain before clipping and its clipping curve. Overdrive rounds off gently, distortion clips
/// hard past a short knee, and fuzz clips its offset input with far more gain.
fn drive_gain(drive: &Drive) -> f64 {
    let squared = drive.drive * drive.drive;
    match drive.model.as_str() {
        "distortion" => 1.0 + 400.0 * squared,
        "fuzz" => 1.0 + 2_000.0 * squared,
        _ => 1.0 + 40.0 * squared,
    }
}
/// `hard` picks distortion's knee; the other models round off with `tanh`.
fn drive_curve(hard: bool, v: f64) -> f64 {
    if hard {
        // A cubic knee that reaches its ceiling with zero slope at 1.5.
        let s = v.clamp(-1.5, 1.5);
        s - 4.0 / 27.0 * s * s * s
    } else {
        v.tanh()
    }
}
/// One drive setting resolved for the audio thread: its curve, gain before clipping, the gain that brings a
/// reference-level sine back to its own level after clipping (measured over one period with the offset removed,
/// as the pedal's DC blocker removes it), the fuzz's offset share, and the tone filter and output level.
#[derive(Clone, Copy)]
struct DriveShape {
    hard: bool,
    gain: f64,
    normal: f64,
    bias: f64,
    tone: f64,
    level: f64,
}
fn drive_shape(drive: &Drive, rate: f64) -> DriveShape {
    let (hard, gain, bias) = (
        drive.model == "distortion",
        drive_gain(drive),
        if drive.model == "fuzz" {
            FUZZ_BIAS
        } else {
            0.0
        },
    );
    let (mut sum, mut squares) = (0.0, 0.0);
    for n in 0..256 {
        let y = drive_curve(
            hard,
            gain * DRIVE_REFERENCE * ((std::f64::consts::TAU * n as f64 / 256.0).sin() + bias),
        );
        sum += y;
        squares += y * y;
    }
    let rms = (squares / 256.0 - (sum / 256.0).powi(2)).max(0.0).sqrt();
    let tone_hz = 500.0 * (12_000.0f64 / 500.0).powf(drive.tone);
    DriveShape {
        hard,
        gain,
        normal: DRIVE_REFERENCE / std::f64::consts::SQRT_2 / rms.max(1e-12),
        bias,
        tone: 1.0 - (-std::f64::consts::TAU * tone_hz.min(rate * 0.45) / rate).exp(),
        level: 10f64.powf(drive.level_db / 20.0),
    }
}
/// One block of the signal chain.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Stage {
    Microphone,
    Gate,
    Compressor,
    Wah,
    Octaver,
    Pitch,
    Drive,
    Amp,
    Cabinet,
    Eq,
    GraphicEq,
    Vibrato,
    Phaser,
    Flanger,
    Chorus,
    Tremolo,
    Delay,
    Reverb,
}
/// The blocks by name, in their default order.
const STAGES: [(&str, Stage); 18] = [
    ("microphone", Stage::Microphone),
    ("gate", Stage::Gate),
    ("compressor", Stage::Compressor),
    ("wah", Stage::Wah),
    ("octaver", Stage::Octaver),
    ("pitch", Stage::Pitch),
    ("drive", Stage::Drive),
    ("amp", Stage::Amp),
    ("cabinet", Stage::Cabinet),
    ("eq", Stage::Eq),
    ("graphicEq", Stage::GraphicEq),
    ("vibrato", Stage::Vibrato),
    ("phaser", Stage::Phaser),
    ("flanger", Stage::Flanger),
    ("chorus", Stage::Chorus),
    ("tremolo", Stage::Tremolo),
    ("delay", Stage::Delay),
    ("reverb", Stage::Reverb),
];
/// The chain a validated order names, or the default chain for an empty one.
/// Blocks added after orders could be saved. An order saved before one of them leaves it out, and it plays just
/// after the block before it in the default order.
const LATER_STAGES: [&str; 1] = ["graphicEq"];
fn chain_of(order: &[String]) -> [Stage; 18] {
    if order.is_empty() {
        return STAGES.map(|(_, stage)| stage);
    }
    let mut chain = [Stage::Microphone; 18];
    let mut len = 0;
    for name in order {
        if let Some((_, stage)) = STAGES.iter().find(|(known, _)| known == name) {
            chain[len] = *stage;
            len += 1;
        }
    }
    for (index, (name, stage)) in STAGES.iter().enumerate() {
        if len < chain.len() && !order.iter().any(|named| named == name) {
            let at = match index {
                0 => 0,
                _ => chain[..len]
                    .iter()
                    .position(|playing| *playing == STAGES[index - 1].1)
                    .map_or(len, |before| before + 1),
            };
            chain.copy_within(at..len, at + 1);
            chain[at] = *stage;
            len += 1;
        }
    }
    chain
}
/// Whether `fx` switches `stage` on.
fn stage_on(fx: &FxSettings, stage: Stage) -> bool {
    match stage {
        Stage::Microphone => fx.microphone.enabled,
        Stage::Gate => fx.gate.enabled,
        Stage::Compressor => fx.compressor.enabled,
        Stage::Wah => fx.wah.enabled,
        Stage::Octaver => fx.octaver.enabled,
        Stage::Pitch => fx.pitch.enabled,
        Stage::Drive => fx.drive.enabled,
        Stage::Amp => fx.amp.enabled,
        Stage::Cabinet => fx.cabinet.enabled,
        Stage::Eq => fx.eq.enabled,
        Stage::GraphicEq => fx.graphic_eq.enabled,
        Stage::Vibrato => fx.vibrato.enabled,
        Stage::Phaser => fx.phaser.enabled,
        Stage::Flanger => fx.flanger.enabled,
        Stage::Chorus => fx.chorus.enabled,
        Stage::Tremolo => fx.tremolo.enabled,
        Stage::Delay => fx.delay.enabled,
        Stage::Reverb => fx.reverb.enabled,
    }
}
/// Where the sound bank's microphone stands. Standard leaves the recording as it is.
const MICROPHONE_PLACEMENTS: [&str; 4] = ["standard", "close", "edge", "room"];
/// The room microphone's early reflections, as (seconds, gain), for the left and the right channel, and the level
/// of the direct sound beside them. Each channel hears different walls, so a centred source spreads out.
const ROOM_REFLECTIONS: [[(f64, f64); 2]; 2] = [
    [(0.0113, 0.35), (0.0239, 0.2)],
    [(0.0137, 0.35), (0.0191, 0.2)],
];
const ROOM_DIRECT: f64 = 0.8;
/// One microphone setting resolved for the audio thread: its tone filters, and whether it adds a room's
/// reflections and folds to mono.
#[derive(Clone, Copy)]
struct MicrophoneShape {
    filters: [Biquad; 3],
    room: bool,
    mono: bool,
}
/// Close: the proximity effect lifts the lows and the highs soften. Edge: off the axis, thinner lows and more
/// presence. Room: at a distance, the lowest lows and the highs fade.
fn microphone_shape(microphone: &Microphone, rate: f64) -> MicrophoneShape {
    let mut filters = [Biquad::default(); 3];
    match microphone.placement.as_str() {
        "close" => {
            filters[0].shelf(200.0, 6.0, rate, false);
            filters[1].shelf(6_000.0, -3.0, rate, true);
        }
        "edge" => {
            filters[0].shelf(250.0, -5.0, rate, false);
            filters[1].peak(4_500.0, 6.0, rate);
        }
        "room" => {
            filters[0].pass(80.0, rate, true);
            filters[1].shelf(4_000.0, -6.0, rate, true);
        }
        _ => {}
    }
    MicrophoneShape {
        filters,
        room: microphone.placement == "room",
        mono: microphone.output == "mono",
    }
}
const DELAY_MODELS: [&str; 3] = ["digital", "tape", "analog"];
/// Echo durations in quarter notes: straight, dotted and triplet divisions.
const DELAY_DIVISIONS: [f64; 10] = [
    0.125,
    0.25,
    1.0 / 3.0,
    0.5,
    2.0 / 3.0,
    0.75,
    1.0,
    1.5,
    2.0,
    4.0,
];
/// One delay setting resolved for the audio thread. Digital repeats are exact copies. Tape and analog repeats
/// pass through a low-pass and a high-pass, round off in a soft clipper, and are read from a delay that wanders:
/// tape's with slow wow and fast flutter, analog's with a gentle slow drift. Their filters act on every repeat, so
/// each one is darker than the last.
#[derive(Clone, Copy)]
struct DelayShape {
    colored: bool,
    /// One-pole low-pass and high-pass coefficients.
    low: f64,
    high: f64,
    /// The soft clipper's gain, which it divides out again so quiet repeats keep their level.
    drive: f64,
    /// The wow and flutter depths in frames, and their phase steps per frame.
    depth: [f64; 2],
    step: [f64; 2],
}
fn delay_shape(delay: &Delay, rate: f64) -> DelayShape {
    let one_pole = |hz: f64| 1.0 - (-std::f64::consts::TAU * hz.min(rate * 0.45) / rate).exp();
    let step = |hz: f64| std::f64::consts::TAU * hz / rate;
    match delay.model.as_str() {
        "tape" => DelayShape {
            colored: true,
            low: one_pole(4_500.0),
            high: one_pole(80.0),
            drive: 1.5,
            depth: [0.0012 * rate, 0.00008 * rate],
            step: [step(0.6), step(7.0)],
        },
        "analog" => DelayShape {
            colored: true,
            low: one_pole(2_200.0),
            high: one_pole(60.0),
            drive: 1.2,
            depth: [0.00035 * rate, 0.0],
            step: [step(0.4), 0.0],
        },
        _ => DelayShape {
            colored: false,
            low: 1.0,
            high: 0.0,
            drive: 1.0,
            depth: [0.0; 2],
            step: [0.0; 2],
        },
    }
}
/// A reverb model built on a four-line feedback delay network: a pre-delay, four allpass diffusers, four delay
/// lines mixed through a Hadamard matrix with a low-pass in each, and for the spring chains of stretched allpass
/// filters on the input and in each line that delay low frequencies more than high ones on every trip, and a narrow
/// output band.
struct ReverbFamily {
    predelay: f64,
    diffusers: [f64; 4],
    diffusion: f64,
    lines: [f64; 4],
    /// Decay time to -60 dB at room 0 and room 1, in seconds.
    decay: [f64; 2],
    /// How long `REVERB_BRIGHT_HZ` rings against the decay time, at damping 0 and damping 1.
    bright: [f64; 2],
    /// The spring's allpass coefficient, or 0.
    chirp: f64,
    /// The output's high-pass and low-pass cutoffs in Hz, or 0 for none.
    band: [f64; 2],
    /// A low-pass on the input in Hz, or 0 for none: a hall's air absorbs the highs before they reach the walls.
    color: f64,
    gain: f64,
}
const REVERB_FAMILIES: [ReverbFamily; 3] = [
    ReverbFamily {
        predelay: 0.02,
        diffusers: [0.00477, 0.00359, 0.01273, 0.00931],
        diffusion: 0.7,
        lines: [0.0437, 0.0531, 0.0613, 0.0739],
        decay: [1.2, 6.0],
        bright: [0.7, 0.3],
        chirp: 0.0,
        band: [0.0, 0.0],
        color: 5_000.0,
        gain: 0.34,
    },
    ReverbFamily {
        predelay: 0.0,
        diffusers: [0.00141, 0.00213, 0.00371, 0.00529],
        diffusion: 0.75,
        lines: [0.0113, 0.0157, 0.0199, 0.0241],
        decay: [0.8, 4.4],
        bright: [1.0, 0.7],
        chirp: 0.0,
        band: [0.0, 0.0],
        color: 0.0,
        gain: 0.12,
    },
    ReverbFamily {
        predelay: 0.0,
        diffusers: [0.00071, 0.00113, 0.00163, 0.00197],
        diffusion: 0.3,
        lines: [0.0293, 0.0317, 0.0341, 0.0373],
        decay: [0.8, 2.8],
        bright: [0.7, 0.35],
        chirp: -0.75,
        band: [120.0, 3_500.0],
        color: 0.0,
        gain: 0.5,
    },
];
/// Stretched allpass stages in each spring chain.
const SPRING_STAGES: usize = 24;
/// The stretched allpass filters' longest delay in frames, reached at 192 kHz.
const SPRING_STRETCH: usize = 16;
/// The frequency whose decay time the damping sets, below every supported rate's Nyquist frequency.
const REVERB_BRIGHT_HZ: f64 = 3_000.0;
const REVERB_MODELS: [&str; 4] = ["room", "hall", "plate", "spring"];
fn reverb_frames(seconds: f64, rate: f64) -> usize {
    ((seconds * rate).round() as usize).max(1)
}
/// The spring's stretch: a stretched allpass repeats its dispersion every rate / stretch, and at about 12 kHz the
/// repeat falls where the output band has removed it, while the strongest dispersion stays below about 6 kHz.
fn spring_stretch(rate: f64) -> usize {
    ((rate / 12_000.0).round() as usize).clamp(1, SPRING_STRETCH)
}
/// A reverb family's loop lengths in frames at low frequencies: each line, plus for the spring its chain's delay.
/// The chain delays high frequencies far less, so the spring's upper band decays somewhat faster than `bright` says.
fn reverb_loops(family: &ReverbFamily, rate: f64) -> [f64; 4] {
    let chirp = if family.chirp != 0.0 {
        (SPRING_STAGES * spring_stretch(rate)) as f64 * (1.0 - family.chirp) / (1.0 + family.chirp)
    } else {
        0.0
    };
    family
        .lines
        .map(|seconds| reverb_frames(seconds, rate) as f64 + chirp)
}
/// The coefficient k of a one-pole low-pass y += k(x - y) whose gain at `w` radians per frame is `gain`.
fn one_pole_for(gain: f64, w: f64) -> f64 {
    if gain >= 1.0 - 1e-9 {
        return 1.0;
    }
    // With q = 1 - k, k² = gain²(1 - 2q·cos w + q²) is a quadratic in q; its root below 1 is the stable one.
    let (g2, c) = (gain * gain, w.cos());
    let (a, b) = (1.0 - g2, 1.0 - g2 * c);
    let q = (b - (b * b - a * a).max(0.0).sqrt()) / a;
    (1.0 - q).clamp(1e-6, 1.0)
}
/// One reverb setting resolved for the audio thread: its model (0 for the room, otherwise a family index plus
/// one), each line's feedback for the decay time, and each line's low-pass coefficient, set so that its loss at
/// `REVERB_BRIGHT_HZ` gives that frequency its own, shorter decay time at any rate.
#[derive(Clone, Copy)]
struct ReverbShape {
    model: usize,
    feedback: [f64; 4],
    cut: [f64; 4],
}
fn reverb_shape(reverb: &Reverb, rate: f64) -> ReverbShape {
    let model = REVERB_MODELS
        .iter()
        .position(|name| *name == reverb.model)
        .unwrap_or(0);
    if model == 0 {
        return ReverbShape {
            model,
            feedback: [0.0; 4],
            cut: [0.0; 4],
        };
    }
    let family = &REVERB_FAMILIES[model - 1];
    let decay = family.decay[0] + (family.decay[1] - family.decay[0]) * reverb.room;
    let bright = family.bright[0] + (family.bright[1] - family.bright[0]) * reverb.damping;
    let loops = reverb_loops(family, rate);
    let gain = |frames: f64, time: f64| 10f64.powf(-3.0 * frames / (rate * time));
    let w = std::f64::consts::TAU * REVERB_BRIGHT_HZ / rate;
    ReverbShape {
        model,
        feedback: loops.map(|frames| gain(frames, decay)),
        cut: loops
            .map(|frames| one_pole_for(gain(frames, decay * bright) / gain(frames, decay), w)),
    }
}
/// A mono delay line read whole frames back.
struct Ring {
    frames: Vec<f64>,
    cursor: usize,
}
impl Ring {
    fn new(length: usize) -> Self {
        Self {
            frames: vec![0.0; length + 1],
            cursor: 0,
        }
    }
    fn read(&self, back: usize) -> f64 {
        let len = self.frames.len();
        self.frames[(self.cursor + len - back.clamp(1, len - 1)) % len]
    }
    fn write(&mut self, x: f64) {
        self.frames[self.cursor] = x;
        self.cursor = (self.cursor + 1) % self.frames.len();
    }
    fn reset(&mut self) {
        self.frames.fill(0.0);
        self.cursor = 0;
    }
}
/// The spring's five chains of stretched first-order allpass filters, y[n] = a·x[n] + x[n-K] - a·y[n-K]: one on
/// the input and one in each line. Every filter keeps its last K inputs and outputs, all at one shared position.
struct Chirp {
    history: Vec<[f64; 2]>,
    stretch: usize,
    at: usize,
}
impl Chirp {
    fn new(rate: f64) -> Self {
        let stretch = spring_stretch(rate);
        Self {
            history: vec![[0.0; 2]; 5 * SPRING_STAGES * stretch],
            stretch,
            at: 0,
        }
    }
    fn run(&mut self, chain: usize, a: f64, mut x: f64) -> f64 {
        for stage in 0..SPRING_STAGES {
            let slot = &mut self.history[(chain * SPRING_STAGES + stage) * self.stretch + self.at];
            let y = flush(a * x + slot[0] - a * slot[1]);
            *slot = [x, y];
            x = y;
        }
        x
    }
    /// Moves every filter on one frame, after each chain has run once.
    fn advance(&mut self) {
        self.at = if self.at + 1 == self.stretch {
            0
        } else {
            self.at + 1
        };
    }
    fn reset(&mut self) {
        self.history.fill([0.0; 2]);
        self.at = 0;
    }
}
/// One reverb family's running state, and whether it ran on the previous frame.
struct Tank {
    family: usize,
    predelay: usize,
    pre: Ring,
    diffuser_frames: [usize; 4],
    diffusers: [Ring; 4],
    line_frames: [usize; 4],
    lines: [Ring; 4],
    damp: [f64; 4],
    chirp: Option<Chirp>,
    color: f64,
    color_state: f64,
    band: [f64; 2],
    band_state: [[f64; 3]; 2],
    live: bool,
}
impl Tank {
    fn new(family: usize, rate: f64) -> Self {
        let shape = &REVERB_FAMILIES[family];
        let frames = |seconds: f64| reverb_frames(seconds, rate);
        Self {
            family,
            predelay: if shape.predelay > 0.0 {
                frames(shape.predelay)
            } else {
                0
            },
            pre: Ring::new(frames(shape.predelay.max(0.001))),
            diffuser_frames: shape.diffusers.map(frames),
            diffusers: shape.diffusers.map(|seconds| Ring::new(frames(seconds))),
            line_frames: shape.lines.map(frames),
            lines: shape.lines.map(|seconds| Ring::new(frames(seconds))),
            damp: [0.0; 4],
            chirp: if shape.chirp != 0.0 {
                Some(Chirp::new(rate))
            } else {
                None
            },
            band: shape.band.map(|hz| {
                if hz > 0.0 {
                    1.0 - (-std::f64::consts::TAU * hz.min(rate * 0.45) / rate).exp()
                } else {
                    0.0
                }
            }),
            band_state: [[0.0; 3]; 2],
            color: if shape.color > 0.0 {
                1.0 - (-std::f64::consts::TAU * shape.color.min(rate * 0.45) / rate).exp()
            } else {
                0.0
            },
            color_state: 0.0,
            live: false,
        }
    }
    fn reset(&mut self) {
        self.pre.reset();
        for ring in self.diffusers.iter_mut().chain(self.lines.iter_mut()) {
            ring.reset();
        }
        self.damp = [0.0; 4];
        if let Some(chirp) = &mut self.chirp {
            chirp.reset();
        }
        self.band_state = [[0.0; 3]; 2];
        self.color_state = 0.0;
    }
    fn run(&mut self, input: f64, feedback: [f64; 4], cut: [f64; 4]) -> [f64; 2] {
        let family = &REVERB_FAMILIES[self.family];
        let mut input = input;
        if self.color > 0.0 {
            self.color_state = flush(self.color_state + self.color * (input - self.color_state));
            input = self.color_state;
        }
        if let Some(chirp) = &mut self.chirp {
            input = chirp.run(4, family.chirp, input);
        }
        self.pre.write(input);
        let mut v = if self.predelay > 0 {
            self.pre.read(self.predelay)
        } else {
            input
        };
        for i in 0..4 {
            let d = self.diffusers[i].read(self.diffuser_frames[i]);
            let w = flush(v + family.diffusion * d);
            self.diffusers[i].write(w);
            v = d - family.diffusion * w;
        }
        let o: [f64; 4] = std::array::from_fn(|i| self.lines[i].read(self.line_frames[i]));
        for i in 0..4 {
            self.damp[i] = flush(self.damp[i] + cut[i] * (o[i] - self.damp[i]));
        }
        let s: [f64; 4] = std::array::from_fn(|i| self.damp[i] * feedback[i]);
        let mixed = [
            s[0] + s[1] + s[2] + s[3],
            s[0] - s[1] + s[2] - s[3],
            s[0] + s[1] - s[2] - s[3],
            s[0] - s[1] - s[2] + s[3],
        ];
        for i in 0..4 {
            let mut back = mixed[i] * 0.5;
            if let Some(chirp) = &mut self.chirp {
                back = chirp.run(i, family.chirp, back);
            }
            self.lines[i].write(flush(back + if i % 2 == 0 { v } else { -v }));
        }
        // The diffused input is heard at once as early reflections, then the lines' first returns follow.
        if let Some(chirp) = &mut self.chirp {
            chirp.advance();
        }
        let out = [o[0] - o[3] + 0.5 * v, o[1] - o[2] - 0.5 * v];
        std::array::from_fn(|c| {
            let mut y = out[c] * family.gain;
            let [high, low] = self.band;
            let state = &mut self.band_state[c];
            if high > 0.0 {
                state[0] = flush(state[0] + high * (y - state[0]));
                y -= state[0];
            }
            if low > 0.0 {
                state[1] = flush(state[1] + low * (y - state[1]));
                state[2] = flush(state[2] + low * (state[1] - state[2]));
                y = state[2];
            }
            y
        })
    }
}
/// The original room reverb: four damped combs fed with the input and crossing channels.
fn room_reverb(
    lines: &mut [DelayLine; 4],
    damp: &mut [[f32; 2]; 4],
    x: [f32; 2],
    room: f64,
    damping: f64,
) -> [f32; 2] {
    let mut wet = [0.0; 2];
    let feedback = (0.55 + 0.37 * room) as f32;
    let damping = (0.05 + 0.9 * damping) as f32;
    for i in 0..4 {
        let y = lines[i].read((lines[i].frames.len() - 1) as f64);
        for (c, value) in wet.iter_mut().enumerate() {
            damp[i][c] = y[c] * (1.0 - damping) + damp[i][c] * damping;
            *value += y[c] * 0.25;
        }
        lines[i].write(std::array::from_fn(|c| x[c] + damp[i][1 - c] * feedback));
    }
    wet
}
/// One pitch shifter's tap state: the shared phase, each tap's alignment offset and its last phase.
#[derive(Clone, Copy)]
struct Shifter {
    phase: f64,
    offsets: [f64; 2],
    last: [f64; 2],
}
impl Default for Shifter {
    fn default() -> Self {
        Self {
            phase: 0.0,
            offsets: [0.0; 2],
            last: [0.0, 0.5],
        }
    }
}
/// The shifter's window, alignment search and match lengths in seconds. The search spans a period of 40 Hz,
/// a bass guitar's low E.
const SHIFT_WINDOW: f64 = 0.04;
const SHIFT_SEARCH: f64 = 0.025;
const SHIFT_MATCH: f64 = 0.004;
/// The alignment search first compares every `rate / 12 kHz` frames, so its cost does not grow with the rate.
const SHIFT_SEARCH_RATE: f64 = 12_000.0;
/// A polyphonic pitch shifter: two taps sweep through the delay line half a window apart, each faded in and
/// out with a Hann window, so their sum reads the input at `ratio` times its speed with steady level. When a
/// tap restarts its grain, silent at that moment, it starts where its waveform best continues the other tap's,
/// so grains join in phase instead of smearing a steady tone into sidebands.
fn shift(line: &DelayLine, state: &mut Shifter, ratio: f64, window: f64, rate: f64) -> [f32; 2] {
    let mut out = [0.0f32; 2];
    let phases = [state.phase, (state.phase + 0.5).fract()];
    for tap in 0..2 {
        let p = phases[tap];
        if (p - state.last[tap]).abs() > 0.5 {
            let other = 1 - tap;
            let anchor = 2.0 + phases[other] * window + state.offsets[other];
            state.offsets[tap] = best_match(
                line,
                anchor.round() as usize,
                (2.0 + p * window).round() as usize,
                rate,
            ) as f64;
        }
        state.last[tap] = p;
        let weight = (std::f64::consts::PI * p).sin().powi(2) as f32;
        let x = line.read(2.0 + p * window + state.offsets[tap]);
        out = std::array::from_fn(|c| out[c] + x[c] * weight);
    }
    // Reading at `ratio` times real time means the delay grows by 1 - ratio frames a frame.
    state.phase = (state.phase + (1.0 - ratio) / window).rem_euclid(1.0);
    out
}
/// The extra delay, up to the search length, at which the line's recent waveform best matches that at `anchor`.
/// A coarse pass compares every `stride` frames; a fine pass then checks the frames around the best one.
fn best_match(line: &DelayLine, anchor: usize, start: usize, rate: f64) -> usize {
    let stride = (rate / SHIFT_SEARCH_RATE).round().max(1.0) as usize;
    let (search, length) = (
        (rate * SHIFT_SEARCH) as usize,
        (rate * SHIFT_MATCH) as usize,
    );
    let score = |offset: usize| {
        let (mut dot, mut energy) = (0.0, 1e-12);
        for j in (0..length).step_by(stride) {
            let b = line.mono(start + offset + j);
            dot += line.mono(anchor + j) * b;
            energy += b * b;
        }
        dot / energy.sqrt()
    };
    let pick = |offsets: &mut dyn Iterator<Item = usize>| {
        offsets
            .fold((0, f64::MIN), |best, offset| {
                let value = score(offset);
                if value > best.1 {
                    (offset, value)
                } else {
                    best
                }
            })
            .0
    };
    let coarse = pick(&mut (0..=search).step_by(stride));
    pick(&mut (coarse.saturating_sub(stride - 1)..=(coarse + stride - 1).min(search)))
}
/// Zeroes vanishing feedback values so silence does not leave slow denormal arithmetic running.
fn flush(value: f64) -> f64 {
    if value.abs() < 1e-20 { 0.0 } else { value }
}

impl FxSettings {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value, low, high) in [
            ("gate threshold", self.gate.threshold_db, -96.0, 0.0),
            ("gate release", self.gate.release_ms, 1.0, 1000.0),
            (
                "compressor threshold",
                self.compressor.threshold_db,
                -60.0,
                0.0,
            ),
            ("compressor ratio", self.compressor.ratio, 1.0, 20.0),
            ("compressor attack", self.compressor.attack_ms, 0.1, 200.0),
            (
                "compressor release",
                self.compressor.release_ms,
                1.0,
                2000.0,
            ),
            ("compressor makeup", self.compressor.makeup_db, 0.0, 24.0),
            ("amp drive", self.amp.drive, 0.0, 1.0),
            ("amp gain", self.amp.gain_db, -24.0, 24.0),
            ("amp bass", self.amp.bass_db, -12.0, 12.0),
            ("amp mid", self.amp.mid_db, -12.0, 12.0),
            ("amp treble", self.amp.treble_db, -12.0, 12.0),
            ("amp presence", self.amp.presence_db, -12.0, 12.0),
            ("EQ low", self.eq.low_db, -24.0, 24.0),
            ("EQ mid", self.eq.mid_db, -24.0, 24.0),
            ("EQ high", self.eq.high_db, -24.0, 24.0),
            ("EQ frequency", self.eq.mid_hz, 200.0, 5000.0),
            ("chorus rate", self.chorus.rate_hz, 0.1, 8.0),
            ("chorus depth", self.chorus.depth_ms, 0.0, 20.0),
            ("chorus mix", self.chorus.mix, 0.0, 1.0),
            ("delay feedback", self.delay.feedback, 0.0, 0.9),
            ("delay mix", self.delay.mix, 0.0, 1.0),
            ("reverb room", self.reverb.room, 0.0, 1.0),
            ("reverb damping", self.reverb.damping, 0.0, 1.0),
            ("reverb mix", self.reverb.mix, 0.0, 1.0),
            ("flanger rate", self.flanger.rate_hz, 0.05, 5.0),
            ("flanger depth", self.flanger.depth_ms, 0.0, 10.0),
            ("flanger feedback", self.flanger.feedback, -0.9, 0.9),
            ("flanger mix", self.flanger.mix, 0.0, 1.0),
            ("phaser rate", self.phaser.rate_hz, 0.05, 5.0),
            ("phaser depth", self.phaser.depth, 0.0, 1.0),
            ("phaser feedback", self.phaser.feedback, 0.0, 0.9),
            ("phaser mix", self.phaser.mix, 0.0, 1.0),
            ("tremolo rate", self.tremolo.rate_hz, 0.1, 20.0),
            ("tremolo depth", self.tremolo.depth, 0.0, 1.0),
            ("vibrato rate", self.vibrato.rate_hz, 1.0, 14.0),
            ("vibrato depth", self.vibrato.depth_cents, 0.0, 100.0),
            ("wah position", self.wah.position, 0.0, 1.0),
            ("wah resonance", self.wah.resonance, 0.0, 1.0),
            ("wah sensitivity", self.wah.sensitivity, 0.0, 1.0),
            ("wah mix", self.wah.mix, 0.0, 1.0),
            ("octaver octave down", self.octaver.octave_down, 0.0, 1.0),
            (
                "octaver two octaves down",
                self.octaver.two_octaves_down,
                0.0,
                1.0,
            ),
            ("octaver direct", self.octaver.direct, 0.0, 1.0),
            ("pitch semitones", self.pitch.semitones, -24.0, 24.0),
            ("pitch mix", self.pitch.mix, 0.0, 1.0),
            ("drive amount", self.drive.drive, 0.0, 1.0),
            ("drive tone", self.drive.tone, 0.0, 1.0),
            ("drive level", self.drive.level_db, -24.0, 12.0),
        ] {
            if !value.is_finite() || value < low || value > high {
                return Err(format!("Invalid {name}: expected {low}..{high}."));
            }
        }
        if !DELAY_MODELS.contains(&self.delay.model.as_str()) {
            return Err("Unknown delay model.".into());
        }
        for (name, sync) in [
            ("chorus", self.chorus.sync_quarter_notes),
            ("flanger", self.flanger.sync_quarter_notes),
            ("phaser", self.phaser.sync_quarter_notes),
            ("tremolo", self.tremolo.sync_quarter_notes),
            ("vibrato", self.vibrato.sync_quarter_notes),
        ] {
            if sync != 0.0 && !MODULATION_DIVISIONS.contains(&sync) {
                return Err(format!("Invalid {name} tempo sync note duration."));
            }
        }
        if !DELAY_DIVISIONS.contains(&self.delay.quarter_notes) {
            return Err("Invalid delay note duration.".into());
        }
        if ![2, 4, 6, 8].contains(&self.phaser.stages) {
            return Err("Invalid phaser stages: expected 2, 4, 6 or 8.".into());
        }
        if !["manual", "auto"].contains(&self.wah.mode.as_str()) {
            return Err("Unknown wah mode.".into());
        }
        if !WAH_MODELS.contains(&self.wah.model.as_str()) {
            return Err("Unknown wah model.".into());
        }
        if !["sine", "square"].contains(&self.tremolo.shape.as_str()) {
            return Err("Unknown tremolo shape.".into());
        }
        if !REVERB_MODELS.contains(&self.reverb.model.as_str()) {
            return Err("Unknown reverb model.".into());
        }
        let named = |name: &str| self.order.iter().filter(|block| *block == name).count();
        if !self.order.is_empty()
            && (self
                .order
                .iter()
                .any(|block| !STAGES.iter().any(|(name, _)| name == block))
                || STAGES.iter().any(|(name, _)| {
                    named(name) > 1 || named(name) == 0 && !LATER_STAGES.contains(name)
                }))
        {
            return Err("Invalid effect order.".into());
        }
        if self
            .graphic_eq
            .gains_db
            .iter()
            .chain([&self.graphic_eq.level_db])
            .any(|db| !db.is_finite() || db.abs() > 12.0)
        {
            return Err("Invalid graphic EQ gain: expected -12..12 dB.".into());
        }
        if !MICROPHONE_PLACEMENTS.contains(&self.microphone.placement.as_str()) {
            return Err("Unknown microphone placement.".into());
        }
        if !["stereo", "mono"].contains(&self.microphone.output.as_str()) {
            return Err("Unknown microphone output.".into());
        }
        if !["overdrive", "distortion", "fuzz"].contains(&self.drive.model.as_str()) {
            return Err("Unknown drive model.".into());
        }
        if !["clean", "crunch", "lead", "bass"].contains(&self.amp.model.as_str()) {
            return Err("Unknown amp model.".into());
        }
        if !["open", "closed", "bass"].contains(&self.cabinet.model.as_str()) {
            return Err("Unknown cabinet model.".into());
        }
        if let Some(second) = &self.second {
            if second.second.is_some() {
                return Err("Invalid second pedalboard.".into());
            }
            second.validate()?;
        }
        Ok(())
    }
    pub fn preset(name: &str) -> Result<Self, String> {
        let mut fx = Self::default();
        match name {
            "gm" => {}
            "clean" => {
                fx.amp.enabled = true;
                fx.cabinet.enabled = true;
            }
            "crunch" => {
                fx.amp.enabled = true;
                fx.amp.model = "crunch".into();
                fx.amp.drive = 0.4;
                fx.cabinet.enabled = true;
                fx.cabinet.model = "closed".into();
                fx.eq.enabled = true;
                fx.eq.mid_db = 2.0;
            }
            "lead" => {
                fx.amp.enabled = true;
                fx.amp.model = "lead".into();
                fx.amp.drive = 0.75;
                fx.cabinet.enabled = true;
                fx.cabinet.model = "closed".into();
                fx.delay.enabled = true;
                fx.reverb.enabled = true;
            }
            "bass" => {
                fx.amp.enabled = true;
                fx.amp.model = "bass".into();
                fx.amp.drive = 0.2;
                fx.cabinet.enabled = true;
                fx.cabinet.model = "bass".into();
                fx.compressor.enabled = true;
                fx.compressor.makeup_db = 3.0;
                fx.eq.enabled = true;
                fx.eq.low_db = 3.0;
                fx.eq.high_db = -2.0;
            }
            _ => return Err("Unknown sound preset.".into()),
        }
        Ok(fx)
    }
}

#[derive(Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    z: [[f64; 2]; 2],
}
impl Default for Biquad {
    fn default() -> Self {
        Self {
            b: [1.0, 0.0, 0.0],
            a: [0.0; 2],
            z: [[0.0; 2]; 2],
        }
    }
}
impl Biquad {
    fn set(&mut self, b: [f64; 3], a: [f64; 3]) {
        self.b = b.map(|x| x / a[0]);
        self.a = [a[1] / a[0], a[2] / a[0]];
    }
    fn pass(&mut self, hz: f64, rate: f64, high: bool) {
        let w = std::f64::consts::TAU * hz.min(rate * 0.45) / rate;
        let c = w.cos();
        let alpha = w.sin() / std::f64::consts::SQRT_2;
        let b = if high {
            [(1.0 + c) / 2.0, -1.0 - c, (1.0 + c) / 2.0]
        } else {
            [(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0]
        };
        self.set(b, [1.0 + alpha, -2.0 * c, 1.0 - alpha]);
    }
    fn peak(&mut self, hz: f64, db: f64, rate: f64) {
        let w = std::f64::consts::TAU * hz.min(rate * 0.45) / rate;
        let a = 10f64.powf(db / 40.0);
        let alpha = w.sin() / 1.4;
        self.set(
            [1.0 + alpha * a, -2.0 * w.cos(), 1.0 - alpha * a],
            [1.0 + alpha / a, -2.0 * w.cos(), 1.0 - alpha / a],
        );
    }
    /// A peak of `db` at `hz` with quality `q`.
    fn peak_q(&mut self, hz: f64, db: f64, rate: f64, q: f64) {
        let w = std::f64::consts::TAU * hz.min(rate * 0.45) / rate;
        let a = 10f64.powf(db / 40.0);
        let alpha = w.sin() / (2.0 * q);
        self.set(
            [1.0 + alpha * a, -2.0 * w.cos(), 1.0 - alpha * a],
            [1.0 + alpha / a, -2.0 * w.cos(), 1.0 - alpha / a],
        );
    }
    fn shelf(&mut self, hz: f64, db: f64, rate: f64, high: bool) {
        let w = std::f64::consts::TAU * hz.min(rate * 0.45) / rate;
        let c = w.cos();
        let a = 10f64.powf(db / 40.0);
        let k = w.sin() * (2.0 * a).sqrt();
        let s = if high { 1.0 } else { -1.0 };
        self.set(
            [
                a * ((a + 1.0) + s * (a - 1.0) * c + k),
                -2.0 * s * a * ((a - 1.0) + s * (a + 1.0) * c),
                a * ((a + 1.0) + s * (a - 1.0) * c - k),
            ],
            [
                (a + 1.0) - s * (a - 1.0) * c + k,
                2.0 * s * ((a - 1.0) - s * (a + 1.0) * c),
                (a + 1.0) - s * (a - 1.0) * c - k,
            ],
        );
    }
    fn process(&mut self, x: [f32; 2]) -> [f32; 2] {
        std::array::from_fn(|c| {
            let y = self.b[0] * x[c] as f64 + self.z[c][0];
            self.z[c][0] = self.b[1] * x[c] as f64 - self.a[0] * y + self.z[c][1];
            self.z[c][1] = self.b[2] * x[c] as f64 - self.a[1] * y;
            y as f32
        })
    }
    fn reset(&mut self) {
        self.z = [[0.0; 2]; 2];
    }
    /// Whether what the filter still holds of earlier input is below anything audible.
    fn quiet(&self) -> bool {
        self.z.iter().flatten().all(|z| z.abs() < 1e-7)
    }
}

struct DelayLine {
    frames: Vec<[f32; 2]>,
    cursor: usize,
}
impl DelayLine {
    fn new(length: usize) -> Self {
        Self {
            frames: vec![[0.0; 2]; length.max(2)],
            cursor: 0,
        }
    }
    fn read(&self, offset: f64) -> [f32; 2] {
        let offset = offset.clamp(1.0, (self.frames.len() - 1) as f64);
        let p = (self.cursor as f64 - offset).rem_euclid(self.frames.len() as f64);
        let i = p.floor() as usize;
        let f = (p - i as f64) as f32;
        std::array::from_fn(|c| {
            self.frames[i][c] * (1.0 - f) + self.frames[(i + 1) % self.frames.len()][c] * f
        })
    }
    /// The sum of both channels `offset` whole frames ago.
    fn mono(&self, offset: usize) -> f64 {
        let len = self.frames.len();
        let back = offset.clamp(1, len - 1);
        let index = if self.cursor >= back {
            self.cursor - back
        } else {
            self.cursor + len - back
        };
        let frame = self.frames[index];
        (frame[0] + frame[1]) as f64
    }
    fn write(&mut self, x: [f32; 2]) {
        self.frames[self.cursor] = x;
        self.cursor = (self.cursor + 1) % self.frames.len();
    }
    fn reset(&mut self) {
        self.frames.fill([0.0; 2]);
        self.cursor = 0;
    }
}

pub struct TrackDsp {
    settings: FxSettings,
    previous: FxSettings,
    rate: f64,
    ramp_left: u32,
    ramp_frames: u32,
    gate_envelope: f64,
    compressor_envelope: f64,
    amp_dc: [f64; 2],
    amp_previous_input: [f64; 2],
    amp_anti_alias: [[f64; 3]; 2],
    /// The tone stack's filters and the gains they were set for. They run whenever the amp does, so a flat stack that
    /// is turned up starts from the signal already flowing through them.
    amp_tone: [Biquad; 4],
    cached_amp_tone: [f64; 4],
    /// The tone stack's playing gains in dB, gliding to the settings at up to 0.01 dB a frame so that a large change
    /// does not ring the filters.
    amp_tone_db: [f64; 4],
    cabinet: [Biquad; 3],
    eq: [Biquad; 3],
    /// The graphic EQ's band filters and the gains they were set for.
    graphic_eq: [Biquad; 10],
    cached_graphic_eq: [f64; 10],
    /// The graphic EQ's level in dB and as a gain.
    graphic_eq_level: (f64, f32),
    chorus: DelayLine,
    phase: f64,
    vibrato: DelayLine,
    vibrato_phase: f64,
    /// The vibrato and flanger delay swings in frames, slewed so live edits never scrub the audio.
    vibrato_swing: f64,
    /// The vibrato's playing rate in hertz. It glides to a new rate no faster than the swing can follow, so the pitch
    /// bend keeps its depth while the rate changes.
    vibrato_hz: f64,
    flanger_swing: f64,
    /// First-order all-pass state (previous input, previous output) per channel and stage.
    phaser: [[[f64; 2]; 8]; 2],
    phaser_last: [f64; 2],
    phaser_phase: f64,
    flanger: DelayLine,
    flanger_phase: f64,
    tremolo_phase: f64,
    /// State-variable filter integrator state per channel, the playing-level envelope and the gliding pedal position.
    wah: [[f64; 2]; 2],
    wah_envelope: f64,
    wah_position: f64,
    /// Per-frame smoothing for the envelope's attack and release and the pedal glide.
    wah_coefficients: [f64; 3],
    /// Shifter input history and tap phases: the octaver's one-octave and two-octave shifters share a line.
    octaver: DelayLine,
    octaver_phase: [Shifter; 2],
    pitch: DelayLine,
    pitch_phase: Shifter,
    /// The shifters' window in frames.
    shift_window: f64,
    /// Drive pedal state per channel: the previous input for oversampling, the anti-alias filters, the DC blocker
    /// and the two-pole tone filter; the playing level for the fuzz's offset; the previous and current settings
    /// resolved; and per-frame smoothing for the level's attack and release and the DC blocker.
    drive_previous_input: [f64; 2],
    drive_anti_alias: [[f64; 3]; 2],
    drive_dc: [f64; 2],
    drive_tone: [[f64; 2]; 2],
    drive_envelope: f64,
    drive_shapes: [DriveShape; 2],
    drive_coefficients: [f64; 3],
    delay: DelayLine,
    /// Tape and analog delay state per channel: the repeats' low-pass and high-pass; the wow and flutter phases;
    /// and the previous and current settings resolved.
    delay_filters: [[f64; 2]; 2],
    delay_phase: [f64; 2],
    delay_shapes: [DelayShape; 2],
    /// The microphone's previous and current settings resolved, each with its filters' state; the line of direct
    /// sound that a room's reflections repeat; and whether the block has been running.
    microphone_shapes: [MicrophoneShape; 2],
    /// The chain playing, the chain the settings ask for, and the frames left of a reorder's fade out and back in.
    chain: [Stage; 18],
    chain_target: [Stage; 18],
    reorder_left: u32,
    microphone_room: DelayLine,
    /// Frames since the line was cleared while sound played, so each reflection fades in once its delay has
    /// filled. A track starting from silence has nothing to fade from and starts full.
    microphone_age: f64,
    microphone_live: bool,
    reverb: [DelayLine; 4],
    reverb_damp: [[f32; 2]; 4],
    /// The hall, plate and spring, the previous and current settings resolved, and whether the room ran on the
    /// previous frame. A model that starts running again starts silent.
    reverb_tanks: Box<[Tank; 3]>,
    reverb_shapes: [ReverbShape; 2],
    reverb_live: bool,
    cached_eq: [f64; 4],
    cached_cabinet: [f64; 2],
    /// The second pedalboard, built only once a sound has one, and how much of its output is heard. It fades in and
    /// out over the ramp; a removed board fades out and then stands still until the next configuration leaves it.
    second: Option<Box<TrackDsp>>,
    second_gain: f32,
    max_delay_seconds: f64,
}
impl TrackDsp {
    pub fn new(
        settings: FxSettings,
        sample_rate: u32,
        max_delay_seconds: f64,
    ) -> Result<Self, String> {
        settings.validate()?;
        if !(8_000..=192_000).contains(&sample_rate)
            || !max_delay_seconds.is_finite()
            || !(0.01..=120.0).contains(&max_delay_seconds)
        {
            return Err("Invalid DSP sample rate or delay capacity.".into());
        }
        let rate = sample_rate as f64;
        let previous_flanger_depth = settings.flanger.depth_ms;
        let amp_tone_start = amp_tone(&settings.amp);
        let wah_start = wah_target(&settings.wah, 0.0);
        let drive_start = drive_shape(&settings.drive, rate);
        let reverb_start = reverb_shape(&settings.reverb, rate);
        let delay_start = delay_shape(&settings.delay, rate);
        let microphone_start = microphone_shape(&settings.microphone, rate);
        let microphone_on = settings.microphone.enabled;
        let chain = chain_of(&settings.order);
        let second = match &settings.second {
            Some(board) => Some(Box::new(TrackDsp::new(
                (**board).clone(),
                sample_rate,
                max_delay_seconds,
            )?)),
            None => None,
        };
        let second_gain = if second.is_some() { 1.0 } else { 0.0 };
        Ok(Self {
            second,
            second_gain,
            max_delay_seconds,
            previous: settings.clone(),
            settings,
            rate,
            ramp_left: 0,
            ramp_frames: (rate * 0.01) as u32,
            gate_envelope: 1.0,
            compressor_envelope: 0.0,
            amp_dc: [0.0; 2],
            amp_previous_input: [0.0; 2],
            amp_anti_alias: [[0.0; 3]; 2],
            amp_tone: [Biquad::default(); 4],
            cached_amp_tone: [f64::NAN; 4],
            amp_tone_db: amp_tone_start,
            cabinet: [Biquad::default(); 3],
            eq: [Biquad::default(); 3],
            graphic_eq: [Biquad::default(); 10],
            cached_graphic_eq: [f64::NAN; 10],
            graphic_eq_level: (f64::NAN, 1.0),
            chorus: DelayLine::new((rate * 0.05) as usize + 2),
            phase: 0.0,
            // The widest vibrato (100 cents at 1 Hz) swings the delay by about 18.4 ms.
            vibrato: DelayLine::new((rate * 0.02) as usize + 8),
            vibrato_phase: 0.0,
            // Set to the settings' swing on the first frame the vibrato plays, when the tempo is known.
            vibrato_swing: f64::NAN,
            vibrato_hz: f64::NAN,
            flanger_swing: rate * previous_flanger_depth * 0.001,
            phaser: [[[0.0; 2]; 8]; 2],
            phaser_last: [0.0; 2],
            phaser_phase: 0.0,
            flanger: DelayLine::new((rate * 0.0105) as usize + 4),
            flanger_phase: 0.0,
            tremolo_phase: 0.0,
            wah: [[0.0; 2]; 2],
            wah_envelope: 0.0,
            wah_position: wah_start,
            wah_coefficients: [0.002, 0.2, 0.015]
                .map(|seconds: f64| 1.0 - (-1.0 / (rate * seconds)).exp()),
            // A tap reads up to the window plus its alignment, and alignment matches a further stretch behind that.
            octaver: DelayLine::new(
                (rate * (SHIFT_WINDOW + 2.0 * SHIFT_SEARCH + SHIFT_MATCH)) as usize + 8,
            ),
            octaver_phase: [Shifter::default(); 2],
            pitch: DelayLine::new(
                (rate * (SHIFT_WINDOW + 2.0 * SHIFT_SEARCH + SHIFT_MATCH)) as usize + 8,
            ),
            pitch_phase: Shifter::default(),
            shift_window: (rate * SHIFT_WINDOW).floor(),
            drive_previous_input: [0.0; 2],
            drive_anti_alias: [[0.0; 3]; 2],
            drive_dc: [0.0; 2],
            drive_tone: [[0.0; 2]; 2],
            drive_envelope: 0.0,
            drive_shapes: [drive_start; 2],
            // The fuzz's offset follows the playing level slowly enough that a note's attack does not thump, and
            // the DC blocker settles what remains within about 16 ms at any rate.
            drive_coefficients: [
                1.0 - (-1.0 / (rate * 0.02)).exp(),
                1.0 - (-1.0 / (rate * 0.05)).exp(),
                1.0 - (-std::f64::consts::TAU * 10.0 / rate).exp(),
            ],
            delay: DelayLine::new((rate * max_delay_seconds).ceil() as usize + 2),
            delay_filters: [[0.0; 2]; 2],
            delay_phase: [0.0; 2],
            delay_shapes: [delay_start; 2],
            microphone_shapes: [microphone_start; 2],
            chain,
            chain_target: chain,
            reorder_left: 0,
            microphone_room: DelayLine::new((rate * 0.03).ceil() as usize + 2),
            microphone_age: rate,
            microphone_live: microphone_on,
            reverb: std::array::from_fn(|i| {
                DelayLine::new((rate * [0.0297, 0.0371, 0.0411, 0.0437][i]) as usize + 23 * i)
            }),
            reverb_damp: [[0.0; 2]; 4],
            reverb_tanks: Box::new(std::array::from_fn(|family| Tank::new(family, rate))),
            reverb_shapes: [reverb_start; 2],
            reverb_live: false,
            cached_eq: [f64::NAN; 4],
            cached_cabinet: [f64::NAN; 2],
        })
    }
    /// Aims the chain at the settings' order. A different order fades out from where the chain is now; going back
    /// to the playing order while it fades out fades it back in from the same level.
    ///
    /// `settled` says no settings change was still crossfading, so the blocks playing are just those the previous and
    /// current settings switch on. A move among the others changes nothing heard, so it applies at once.
    fn retarget_chain(&mut self, settled: bool) {
        self.chain_target = chain_of(&self.settings.order);
        let on =
            |stage: &&Stage| stage_on(&self.settings, **stage) || stage_on(&self.previous, **stage);
        if settled
            && self.reorder_left == 0
            && self
                .chain
                .iter()
                .filter(on)
                .eq(self.chain_target.iter().filter(on))
        {
            self.chain = self.chain_target;
            return;
        }
        let wanted = self.chain_target != self.chain;
        let fading_out = self.reorder_left > self.ramp_frames;
        if wanted != fading_out {
            self.reorder_left = 2 * self.ramp_frames - self.reorder_left;
        }
    }
    /// The current microphone settings resolved, with their filters carrying on from the given state, so a
    /// change crossfades two paths that start alike.
    fn microphone_continued(&self, from: &MicrophoneShape) -> MicrophoneShape {
        let mut shape = microphone_shape(&self.settings.microphone, self.rate);
        for (filter, old) in shape.filters.iter_mut().zip(&from.filters) {
            filter.z = old.z;
        }
        shape
    }
    /// Tape and analog filters stand still while a digital delay plays, so a change from digital starts them silent
    /// instead of from what they held before.
    fn restart_delay_color(&mut self) {
        if !self.delay_shapes[0].colored {
            self.delay_filters = [[0.0; 2]; 2];
        }
    }
    pub fn set_settings(&mut self, settings: FxSettings) -> Result<(), String> {
        settings.validate()?;
        if let Some(board) = &settings.second {
            match &mut self.second {
                // A board that had faded out starts again from silence, at its new settings.
                Some(second) if self.second_gain == 0.0 => {
                    second.set_settings((**board).clone())?;
                    second.previous = second.settings.clone();
                    second.ramp_left = 0;
                    second.reset();
                    second.start_mid_play();
                }
                Some(second) => second.set_settings((**board).clone())?,
                None => {
                    let mut second = Box::new(TrackDsp::new(
                        (**board).clone(),
                        self.rate as u32,
                        self.max_delay_seconds,
                    )?);
                    second.start_mid_play();
                    self.second = Some(second);
                }
            }
        }
        self.previous = std::mem::replace(&mut self.settings, settings);
        self.drive_shapes = [
            self.drive_shapes[1],
            drive_shape(&self.settings.drive, self.rate),
        ];
        self.reverb_shapes = [
            self.reverb_shapes[1],
            reverb_shape(&self.settings.reverb, self.rate),
        ];
        self.delay_shapes = [
            self.delay_shapes[1],
            delay_shape(&self.settings.delay, self.rate),
        ];
        self.restart_delay_color();
        self.microphone_shapes = [
            self.microphone_shapes[1],
            self.microphone_continued(&self.microphone_shapes[1]),
        ];
        self.retarget_chain(self.ramp_left == 0);
        self.ramp_left = self.ramp_frames;
        Ok(())
    }
    /// Move running state into an off-thread prepared configuration; old allocations remain owned by `old`.
    pub fn transition_from(&mut self, old: &mut Self) {
        let running = [
            old.settings.gate.enabled,
            old.settings.compressor.enabled,
            old.settings.amp.enabled,
            old.settings.cabinet.enabled,
            old.settings.eq.enabled,
            old.settings.chorus.enabled,
            old.settings.delay.enabled,
            old.settings.reverb.enabled,
            old.settings.vibrato.enabled,
            old.settings.phaser.enabled,
            old.settings.flanger.enabled,
            old.settings.tremolo.enabled,
            old.settings.wah.enabled,
            old.settings.octaver.enabled,
            old.settings.pitch.enabled,
            old.settings.drive.enabled,
            old.settings.microphone.enabled,
            old.settings.graphic_eq.enabled,
        ];
        std::mem::swap(&mut self.previous, &mut old.settings);
        // The previous settings are the old configuration's current ones, resolved as it resolved them.
        self.drive_shapes[0] = old.drive_shapes[1];
        self.reverb_shapes[0] = old.reverb_shapes[1];
        self.delay_shapes[0] = old.delay_shapes[1];
        self.microphone_shapes[0] = old.microphone_shapes[1];
        // The chain carries on as the old configuration played it, then moves to this one's order.
        self.chain = old.chain;
        // A configuration at another rate fades over another length; this one carries on from the same level.
        self.reorder_left = ((old.reorder_left as u64 * self.ramp_frames as u64)
            / old.ramp_frames as u64)
            .min(2 * self.ramp_frames as u64) as u32;
        self.retarget_chain(old.ramp_left == 0);
        macro_rules! move_state {($($name:ident),*)=>{$(std::mem::swap(&mut self.$name,&mut old.$name);)*}}
        if running[0] {
            move_state!(gate_envelope);
        }
        if running[1] {
            move_state!(compressor_envelope);
        }
        if running[2] {
            move_state!(
                amp_dc,
                amp_previous_input,
                amp_anti_alias,
                amp_tone,
                cached_amp_tone,
                amp_tone_db
            );
        }
        if running[3] {
            move_state!(cabinet, cached_cabinet);
        }
        if running[4] {
            move_state!(eq, cached_eq);
        }
        if running[17] {
            move_state!(graphic_eq, cached_graphic_eq, graphic_eq_level);
        }
        if running[5] {
            move_state!(chorus, phase);
        }
        if running[6] {
            move_state!(delay, delay_filters, delay_phase);
            self.restart_delay_color();
        }
        if running[7] {
            move_state!(reverb, reverb_damp, reverb_tanks, reverb_live);
        }
        if running[8] {
            move_state!(vibrato, vibrato_phase, vibrato_swing, vibrato_hz);
        }
        if running[9] {
            move_state!(phaser, phaser_last, phaser_phase);
        }
        if running[10] {
            move_state!(flanger, flanger_phase, flanger_swing);
        }
        if running[11] {
            move_state!(tremolo_phase);
        }
        if running[12] {
            move_state!(wah, wah_envelope, wah_position);
        }
        if running[13] {
            move_state!(octaver, octaver_phase);
        }
        if running[14] {
            move_state!(pitch, pitch_phase);
        }
        if running[15] {
            move_state!(
                drive_previous_input,
                drive_anti_alias,
                drive_dc,
                drive_tone,
                drive_envelope
            );
        }
        if running[16] {
            self.microphone_shapes[1] = self.microphone_continued(&old.microphone_shapes[1]);
            move_state!(microphone_room, microphone_age, microphone_live);
        } else {
            // Switched on while the track plays: start from silence and fade the reflections in.
            self.microphone_live = false;
        }
        self.ramp_left = self.ramp_frames;
        // The second board carries on, fades in from silence, or fades out before it is left behind. A board that
        // has faded out holds what it last played, so one added again starts afresh. `previous` now holds the old
        // configuration's settings.
        match (&mut self.second, &mut old.second) {
            (Some(second), Some(playing))
                if old.second_gain > 0.0 || self.previous.second.is_some() =>
            {
                second.transition_from(playing);
                self.second_gain = old.second_gain;
            }
            (Some(second), _) => {
                second.start_mid_play();
                self.second_gain = 0.0;
            }
            (None, playing @ Some(_)) if old.second_gain > 0.0 => {
                self.second = playing.take();
                self.second_gain = old.second_gain;
            }
            _ => {}
        }
    }
    /// Readies a board that starts from silence while the track already sounds, as a block switched on mid-play
    /// is: the room microphone's reflections fade in rather than arriving at full level.
    fn start_mid_play(&mut self) {
        self.microphone_live = false;
    }
    pub fn process(&mut self, input: [f32; 2], bpm: f64) -> [f32; 2] {
        let y = self.process_board(input, bpm);
        let Some(second) = &mut self.second else {
            return y;
        };
        let target = if self.settings.second.is_some() {
            1.0
        } else {
            0.0
        };
        if self.second_gain == target && target == 0.0 {
            return y;
        }
        let step = 1.0 / self.ramp_frames as f32;
        self.second_gain = if self.second_gain < target {
            (self.second_gain + step).min(target)
        } else {
            (self.second_gain - step).max(target)
        };
        let wet = second.process(y, bpm);
        if self.second_gain == 1.0 {
            return wet;
        }
        std::array::from_fn(|c| y[c] + (wet[c] - y[c]) * self.second_gain)
    }
    fn process_board(&mut self, input: [f32; 2], bpm: f64) -> [f32; 2] {
        let mut x = input.map(|v| if v.is_finite() { v } else { 0.0 });
        let t = if self.ramp_left == 0 {
            1.0
        } else {
            1.0 - self.ramp_left as f64 / self.ramp_frames as f64
        };
        let lerp = |a: f64, b: f64| a + (b - a) * t;
        let tempo = if bpm.is_finite() && bpm > 0.0 {
            bpm
        } else {
            120.0
        };
        // Each modulation block's rate before and after a settings change, free or following the tempo.
        let hz = |rate_hz: f64, sync: f64, low: f64, high: f64| {
            modulation_hz(rate_hz, sync, tempo, low, high)
        };
        let blend = |dry: [f32; 2], wet: [f32; 2], a: bool, b: bool| {
            let amount = lerp(if a { 1.0 } else { 0.0 }, if b { 1.0 } else { 0.0 }) as f32;
            std::array::from_fn(|c| dry[c] + (wet[c] - dry[c]) * amount)
        };
        let f = &self.settings;
        let p = &self.previous;
        let tau = std::f64::consts::TAU;
        // A reorder fades the chain out, swaps the order at silence and fades it back in.
        let duck = if self.reorder_left > 0 {
            if self.reorder_left == self.ramp_frames {
                self.chain = self.chain_target;
            }
            let gain =
                self.reorder_left.abs_diff(self.ramp_frames) as f32 / self.ramp_frames as f32;
            self.reorder_left -= 1;
            Some(gain)
        } else {
            None
        };
        for stage in self.chain {
            match stage {
                Stage::Microphone => {
                    if f.microphone.enabled || p.microphone.enabled && t < 1.0 {
                        // The sound bank's recording comes first. A block starting again begins from silence.
                        if !self.microphone_live {
                            for shape in &mut self.microphone_shapes {
                                shape.filters.iter_mut().for_each(Biquad::reset);
                            }
                            self.microphone_room.reset();
                            self.microphone_age = 0.0;
                            self.microphone_live = true;
                        }
                        let ramp = t < 1.0;
                        let mut tone = |s: usize| {
                            self.microphone_shapes[s]
                                .filters
                                .iter_mut()
                                .fold(x, |v, filter| filter.process(v))
                        };
                        let direct = [if ramp { tone(0) } else { [0.0; 2] }, tone(1)];
                        let shapes = self.microphone_shapes;
                        // The room's reflections repeat its direct sound. The line keeps the placements' direct sound, crossfaded
                        // as the paths are, while any placement plays, so a change to or from the room reaches each reflection as
                        // a 10 ms crossfade when its delay has passed instead of a step.
                        let room = shapes[1].room || ramp && shapes[0].room;
                        let mut reflections = [0.0f32; 2];
                        if room {
                            // A line cleared when the block started holds silence before its first frames, so each reflection
                            // fades in over 10 ms from when its delay has filled.
                            let (age, fade) = (self.microphone_age, self.rate * 0.01);
                            for c in 0..2 {
                                reflections[c] = ROOM_REFLECTIONS[c]
                                    .iter()
                                    .map(|&(seconds, gain)| {
                                        let delay = seconds * self.rate;
                                        self.microphone_room.read(delay)[0]
                                            * (gain * ((age - delay) / fade).clamp(0.0, 1.0)) as f32
                                    })
                                    .sum();
                            }
                        }
                        self.microphone_age = (self.microphone_age + 1.0).min(self.rate);
                        let written: [f32; 2] = if ramp {
                            std::array::from_fn(|c| {
                                direct[0][c] + (direct[1][c] - direct[0][c]) * t as f32
                            })
                        } else {
                            direct[1]
                        };
                        self.microphone_room
                            .write([(written[0] + written[1]) * 0.5; 2]);
                        let path = |s: usize| -> [f32; 2] {
                            if shapes[s].room {
                                std::array::from_fn(|c| {
                                    direct[s][c] * ROOM_DIRECT as f32 + reflections[c]
                                })
                            } else {
                                direct[s]
                            }
                        };
                        let mut wet = if ramp {
                            let [a, b] = [path(0), path(1)];
                            std::array::from_fn(|c| a[c] + (b[c] - a[c]) * t as f32)
                        } else {
                            path(1)
                        };
                        let mono = lerp(
                            if shapes[0].mono { 1.0 } else { 0.0 },
                            if shapes[1].mono { 1.0 } else { 0.0 },
                        ) as f32;
                        if mono > 0.0 {
                            let centre = (wet[0] + wet[1]) * 0.5;
                            wet = if mono >= 1.0 {
                                [centre; 2]
                            } else {
                                wet.map(|v| v + (centre - v) * mono)
                            };
                        }
                        x = if p.microphone.enabled && f.microphone.enabled {
                            wet
                        } else {
                            blend(x, wet, p.microphone.enabled, f.microphone.enabled)
                        };
                    } else {
                        self.microphone_live = false;
                    }
                }
                Stage::Gate => {
                    if f.gate.enabled || p.gate.enabled && t < 1.0 {
                        let peak = x[0].abs().max(x[1].abs()) as f64;
                        let target = if peak
                            > 10f64.powf(lerp(p.gate.threshold_db, f.gate.threshold_db) / 20.0)
                        {
                            1.0
                        } else {
                            0.0
                        };
                        let k = if target > self.gate_envelope {
                            0.1
                        } else {
                            (-1.0
                                / (self.rate * lerp(p.gate.release_ms, f.gate.release_ms) * 0.001))
                                .exp()
                        };
                        self.gate_envelope = target + (self.gate_envelope - target) * k;
                        x = blend(
                            x,
                            x.map(|v| v * self.gate_envelope as f32),
                            p.gate.enabled,
                            f.gate.enabled,
                        );
                    }
                }
                Stage::Compressor => {
                    if f.compressor.enabled || p.compressor.enabled && t < 1.0 {
                        let level = x[0].abs().max(x[1].abs()) as f64;
                        let time = if level > self.compressor_envelope {
                            lerp(p.compressor.attack_ms, f.compressor.attack_ms)
                        } else {
                            lerp(p.compressor.release_ms, f.compressor.release_ms)
                        };
                        let k = (-1.0 / (self.rate * time * 0.001)).exp();
                        self.compressor_envelope = level + (self.compressor_envelope - level) * k;
                        let db = 20.0 * self.compressor_envelope.max(1e-9).log10();
                        let above = (db
                            - lerp(p.compressor.threshold_db, f.compressor.threshold_db))
                        .max(0.0);
                        let gain = 10f64.powf(
                            (lerp(p.compressor.makeup_db, f.compressor.makeup_db)
                                - above
                                    * (1.0 - 1.0 / lerp(p.compressor.ratio, f.compressor.ratio)))
                                / 20.0,
                        ) as f32;
                        x = blend(
                            x,
                            x.map(|v| v * gain),
                            p.compressor.enabled,
                            f.compressor.enabled,
                        );
                    }
                }
                Stage::Wah => {
                    if f.wah.enabled && !p.wah.enabled && self.ramp_left == self.ramp_frames {
                        // Switching the wah on starts from rest, not from the level and pedal it had when it was switched off.
                        self.wah = [[0.0; 2]; 2];
                        self.wah_envelope = 0.0;
                        self.wah_position = wah_target(&f.wah, 0.0);
                    }
                    if f.wah.enabled || p.wah.enabled && t < 1.0 {
                        // The envelope follows the playing level with a 2 ms attack and a 200 ms release.
                        let level = x[0].abs().max(x[1].abs()) as f64;
                        let [attack, release, glide] = self.wah_coefficients;
                        let k = if level > self.wah_envelope {
                            attack
                        } else {
                            release
                        };
                        self.wah_envelope =
                            flush(self.wah_envelope + (level - self.wah_envelope) * k);
                        let goal = lerp(
                            wah_target(&p.wah, self.wah_envelope),
                            wah_target(&f.wah, self.wah_envelope),
                        );
                        // The pedal glides with a 15 ms time constant, so edits and mode changes sweep instead of jumping.
                        self.wah_position += (goal - self.wah_position) * glide;
                        // A band-pass across the model's sweep, 350 Hz at the heel to 2.2 kHz at the toe for the
                        // classic, passing its centre at unity.
                        let position = self.wah_position;
                        let sweep = |wah: &Wah| {
                            let (heel, toe, base, span) = wah_model(&wah.model);
                            (heel * (toe / heel).powf(position), base, span)
                        };
                        let (to_hz, base, span) = sweep(&f.wah);
                        let (hz, k) = if p.wah.model == f.wah.model || t >= 1.0 {
                            (
                                to_hz,
                                1.0 / (base + span * lerp(p.wah.resonance, f.wah.resonance)),
                            )
                        } else {
                            // Changing model moves the centre in octaves and the damping evenly over the crossfade.
                            let (from_hz, from_base, from_span) = sweep(&p.wah);
                            (
                                from_hz * (to_hz / from_hz).powf(t),
                                1.0 / lerp(
                                    from_base + from_span * p.wah.resonance,
                                    base + span * f.wah.resonance,
                                ),
                            )
                        };
                        let g = (std::f64::consts::PI * hz.min(self.rate * 0.45) / self.rate).tan();
                        let a1 = 1.0 / (1.0 + g * (g + k));
                        let a2 = g * a1;
                        let mix = lerp(p.wah.mix, f.wah.mix) as f32;
                        let wet: [f32; 2] = std::array::from_fn(|c| {
                            let [band, low] = &mut self.wah[c];
                            let v3 = x[c] as f64 - *low;
                            let v1 = a1 * *band + a2 * v3;
                            let v2 = *low + a2 * *band + g * a2 * v3;
                            *band = flush(2.0 * v1 - *band);
                            *low = flush(2.0 * v2 - *low);
                            (k * v1) as f32
                        });
                        x = blend(
                            x,
                            std::array::from_fn(|c| x[c] * (1.0 - mix) + wet[c] * mix),
                            p.wah.enabled,
                            f.wah.enabled,
                        );
                    }
                }
                Stage::Octaver => {
                    if f.octaver.enabled || p.octaver.enabled && t < 1.0 {
                        self.octaver.write(x);
                        let one = shift(
                            &self.octaver,
                            &mut self.octaver_phase[0],
                            0.5,
                            self.shift_window,
                            self.rate,
                        );
                        let two = shift(
                            &self.octaver,
                            &mut self.octaver_phase[1],
                            0.25,
                            self.shift_window,
                            self.rate,
                        );
                        let levels = [
                            lerp(p.octaver.direct, f.octaver.direct) as f32,
                            lerp(p.octaver.octave_down, f.octaver.octave_down) as f32,
                            lerp(p.octaver.two_octaves_down, f.octaver.two_octaves_down) as f32,
                        ];
                        x = blend(
                            x,
                            std::array::from_fn(|c| {
                                x[c] * levels[0] + one[c] * levels[1] + two[c] * levels[2]
                            }),
                            p.octaver.enabled,
                            f.octaver.enabled,
                        );
                    }
                }
                Stage::Pitch => {
                    if f.pitch.enabled || p.pitch.enabled && t < 1.0 {
                        self.pitch.write(x);
                        let ratio = 2f64.powf(lerp(p.pitch.semitones, f.pitch.semitones) / 12.0);
                        let wet = shift(
                            &self.pitch,
                            &mut self.pitch_phase,
                            ratio,
                            self.shift_window,
                            self.rate,
                        );
                        let mix = lerp(p.pitch.mix, f.pitch.mix) as f32;
                        x = blend(
                            x,
                            std::array::from_fn(|c| x[c] * (1.0 - mix) + wet[c] * mix),
                            p.pitch.enabled,
                            f.pitch.enabled,
                        );
                    }
                }
                Stage::Drive => {
                    if f.drive.enabled || p.drive.enabled && t < 1.0 {
                        // The playing level follows with a 20 ms attack and a 50 ms release, for the fuzz's offset.
                        let [attack, release, dc] = self.drive_coefficients;
                        let level = x[0].abs().max(x[1].abs()) as f64;
                        let k = if level > self.drive_envelope {
                            attack
                        } else {
                            release
                        };
                        self.drive_envelope =
                            flush(self.drive_envelope + (level - self.drive_envelope) * k);
                        // While both sides of a ramp are on and clip differently, each clips with its own curve and gain and
                        // the two outputs crossfade; otherwise the side that is on clips alone.
                        let shapes = self.drive_shapes;
                        let both = t < 1.0
                            && p.drive.enabled
                            && f.drive.enabled
                            && (p.drive.model != f.drive.model || p.drive.drive != f.drive.drive);
                        let alone = if f.drive.enabled { 1 } else { 0 };
                        let filter = 1.0 - (-std::f64::consts::TAU * 0.22 / 4.0f64).exp();
                        let (tone, level) = (
                            lerp(shapes[0].tone, shapes[1].tone),
                            lerp(shapes[0].level, shapes[1].level),
                        );
                        let envelope = self.drive_envelope;
                        let wet = std::array::from_fn(|c| {
                            let v = x[c] as f64;
                            // Four times oversampled, as the amp is, so the clipping's upper harmonics do not fold back down.
                            let mut sum = 0.0;
                            for step in 1..=4 {
                                let input = self.drive_previous_input[c]
                                    + (v - self.drive_previous_input[c]) * step as f64 / 4.0;
                                let clip = |shape: DriveShape| {
                                    drive_curve(
                                        shape.hard,
                                        shape.gain * (input + shape.bias * envelope),
                                    ) * shape.normal
                                };
                                let mut sample = if both {
                                    lerp(clip(shapes[0]), clip(shapes[1]))
                                } else {
                                    clip(shapes[alone])
                                };
                                for state in &mut self.drive_anti_alias[c] {
                                    *state = flush(*state + filter * (sample - *state));
                                    sample = *state;
                                }
                                sum += sample;
                            }
                            self.drive_previous_input[c] = v;
                            let clipped = sum / 4.0;
                            self.drive_dc[c] =
                                flush(self.drive_dc[c] + dc * (clipped - self.drive_dc[c]));
                            let mut out = clipped - self.drive_dc[c];
                            for state in &mut self.drive_tone[c] {
                                *state = flush(*state + tone * (out - *state));
                                out = *state;
                            }
                            (out * level) as f32
                        });
                        x = blend(x, wet, p.drive.enabled, f.drive.enabled);
                    }
                }
                Stage::Amp => {
                    if f.amp.enabled || p.amp.enabled && t < 1.0 {
                        let drive = lerp(p.amp.drive, f.amp.drive);
                        let gain = 10f64.powf(lerp(p.amp.gain_db, f.amp.gain_db) / 20.0);
                        let model = |s: &str| match s {
                            // Reference peak .10 corresponds to the measured loud pickup RMS .0704.
                            // Normalization keeps this level steady while quieter notes gain sustain.
                            "crunch" => {
                                let pre = 1.0 + 220.0 * drive.powf(1.2);
                                (pre, 0.10 / (0.10 * pre).tanh(), 0.08 * drive, 1.0)
                            }
                            "lead" => {
                                let pre = 1.0 + 600.0 * drive.powf(1.1);
                                (pre, 0.11 / (0.11 * pre).tanh(), 0.04 * drive, 1.0)
                            }
                            "bass" => {
                                let pre = 1.0 + drive * 3.0;
                                (pre, 1.0 / pre.sqrt(), 0.02 * drive, 0.0)
                            }
                            _ => {
                                let pre = 1.0 + drive;
                                (pre, 1.0 / pre.sqrt(), 0.02 * drive, 0.0)
                            }
                        };
                        let a = model(&p.amp.model);
                        let b = model(&f.amp.model);
                        let pre = lerp(a.0, b.0);
                        let post = lerp(a.1, b.1);
                        let bias = lerp(a.2, b.2);
                        let oversampled = lerp(a.3, b.3);
                        let zero = bias.tanh();
                        let filter = 1.0 - (-std::f64::consts::TAU * 0.22 / 4.0).exp();
                        let wet = std::array::from_fn(|c| {
                            let v = x[c] as f64;
                            let direct = if oversampled == 0.0 {
                                (v * pre + bias).tanh() / pre.sqrt() - zero / pre.sqrt()
                            } else {
                                ((v * pre + bias).tanh() - zero) * post
                            };
                            let mut colored = direct;
                            if oversampled > 0.0 {
                                let mut sum = 0.0;
                                for step in 1..=4 {
                                    let input = self.amp_previous_input[c]
                                        + (v - self.amp_previous_input[c]) * step as f64 / 4.0;
                                    let mut sample = ((input * pre + bias).tanh() - zero) * post;
                                    for state in &mut self.amp_anti_alias[c] {
                                        *state += filter * (sample - *state);
                                        sample = *state;
                                    }
                                    sum += sample;
                                }
                                colored += ((sum / 4.0) - direct) * oversampled;
                            }
                            self.amp_previous_input[c] = v;
                            self.amp_dc[c] += 0.0005 * (colored - self.amp_dc[c]);
                            ((colored - self.amp_dc[c]) * gain) as f32
                        });
                        let wanted = amp_tone(&f.amp);
                        if f.amp.enabled && !p.amp.enabled && self.ramp_left == self.ramp_frames {
                            // Switching the amp on starts its tone stack at its settings, from rest.
                            self.amp_tone_db = wanted;
                            for b in &mut self.amp_tone {
                                b.reset();
                            }
                        }
                        // 0.48 dB a millisecond, so a full 24 dB swing takes 50 ms at any sample rate.
                        let step = 480.0 / self.rate;
                        for (playing, wanted) in self.amp_tone_db.iter_mut().zip(wanted) {
                            *playing = if (wanted - *playing).abs() <= step {
                                wanted
                            } else {
                                *playing + step * (wanted - *playing).signum()
                            };
                        }
                        let tone = self.amp_tone_db;
                        if tone[0] != self.cached_amp_tone[0] {
                            self.amp_tone[0].shelf(AMP_TONE[0], tone[0], self.rate, false);
                        }
                        if tone[1] != self.cached_amp_tone[1] {
                            self.amp_tone[1].peak(AMP_TONE[1], tone[1], self.rate);
                        }
                        if tone[2] != self.cached_amp_tone[2] {
                            self.amp_tone[2].shelf(AMP_TONE[2], tone[2], self.rate, true);
                        }
                        if tone[3] != self.cached_amp_tone[3] {
                            self.amp_tone[3].peak_q(AMP_TONE[3], tone[3], self.rate, 1.0);
                        }
                        self.cached_amp_tone = tone;
                        let mut toned = wet;
                        for b in &mut self.amp_tone {
                            toned = b.process(toned);
                        }
                        // A flat stack passes the amp's output untouched, once the filters have let go of any
                        // earlier boost or cut. Flat filters with no such remainder pass their input exactly.
                        let flat = tone == [0.0; 4] && self.amp_tone.iter().all(Biquad::quiet);
                        if flat {
                            for b in &mut self.amp_tone {
                                b.reset();
                            }
                        }
                        let wet = if flat { wet } else { toned };
                        x = blend(x, wet, p.amp.enabled, f.amp.enabled);
                    }
                }
                Stage::Cabinet => {
                    if f.cabinet.enabled || p.cabinet.enabled && t < 1.0 {
                        let cutoff = |s: &str| match s {
                            "closed" => [90.0, 4200.0],
                            "bass" => [35.0, 3500.0],
                            _ => [65.0, 5500.0],
                        };
                        let a = cutoff(&p.cabinet.model);
                        let b = cutoff(&f.cabinet.model);
                        let values = [lerp(a[0], b[0]), lerp(a[1], b[1])];
                        if values != self.cached_cabinet {
                            self.cabinet[0].pass(values[0], self.rate, true);
                            self.cabinet[1].pass(values[1], self.rate, false);
                            self.cabinet[2].pass(values[1], self.rate, false);
                            self.cached_cabinet = values;
                        }
                        let mut wet = x;
                        for b in &mut self.cabinet {
                            wet = b.process(wet);
                        }
                        x = blend(x, wet, p.cabinet.enabled, f.cabinet.enabled);
                    }
                }
                Stage::Eq => {
                    if f.eq.enabled || p.eq.enabled && t < 1.0 {
                        let values = [
                            lerp(p.eq.low_db, f.eq.low_db),
                            lerp(p.eq.mid_db, f.eq.mid_db),
                            lerp(p.eq.high_db, f.eq.high_db),
                            lerp(p.eq.mid_hz, f.eq.mid_hz),
                        ];
                        if values != self.cached_eq {
                            self.eq[0].shelf(180.0, values[0], self.rate, false);
                            self.eq[1].peak(values[3], values[1], self.rate);
                            self.eq[2].shelf(4000.0, values[2], self.rate, true);
                            self.cached_eq = values;
                        }
                        let mut wet = x;
                        for b in &mut self.eq {
                            wet = b.process(wet);
                        }
                        x = blend(x, wet, p.eq.enabled, f.eq.enabled);
                    }
                }
                Stage::GraphicEq => {
                    if f.graphic_eq.enabled
                        && !p.graphic_eq.enabled
                        && self.ramp_left == self.ramp_frames
                    {
                        // Switching the graphic EQ on starts its bands from rest.
                        for b in &mut self.graphic_eq {
                            b.reset();
                        }
                    }
                    if f.graphic_eq.enabled || p.graphic_eq.enabled && t < 1.0 {
                        // A band centred above what the rate can carry is left flat rather than moved down onto the
                        // bands below it.
                        let gains: [f64; 10] = std::array::from_fn(|band| {
                            if GRAPHIC_EQ_BANDS[band] > self.rate * 0.45 {
                                0.0
                            } else {
                                lerp(p.graphic_eq.gains_db[band], f.graphic_eq.gains_db[band])
                            }
                        });
                        if gains != self.cached_graphic_eq {
                            for (band, filter) in self.graphic_eq.iter_mut().enumerate() {
                                filter.peak_q(
                                    GRAPHIC_EQ_BANDS[band],
                                    gains[band],
                                    self.rate,
                                    GRAPHIC_EQ_Q,
                                );
                            }
                            self.cached_graphic_eq = gains;
                        }
                        let mut wet = x;
                        for b in &mut self.graphic_eq {
                            wet = b.process(wet);
                        }
                        let level_db = lerp(p.graphic_eq.level_db, f.graphic_eq.level_db);
                        if level_db != self.graphic_eq_level.0 {
                            self.graphic_eq_level = (level_db, 10f64.powf(level_db / 20.0) as f32);
                        }
                        let level = self.graphic_eq_level.1;
                        x = blend(
                            x,
                            wet.map(|v| v * level),
                            p.graphic_eq.enabled,
                            f.graphic_eq.enabled,
                        );
                    }
                }
                Stage::Vibrato => {
                    if f.vibrato.enabled || p.vibrato.enabled && t < 1.0 {
                        let (before, after) = (
                            hz(p.vibrato.rate_hz, p.vibrato.sync_quarter_notes, 1.0, 14.0),
                            hz(f.vibrato.rate_hz, f.vibrato.sync_quarter_notes, 1.0, 14.0),
                        );
                        let wanted = lerp(before, after);
                        // The bend's depth is the swing times the rate, so the swing must follow a rate change. It may
                        // move its target by 0.01 frames a frame: well within its slew, and a swing changing that fast
                        // bends pitch by at most 2% on its own. A 1 to 14 Hz change then glides over about a second.
                        let most = 1.0 + 0.01 / self.vibrato_swing;
                        let settled = self.vibrato_hz.is_nan()
                            || !(most < f64::INFINITY)
                            || wanted <= self.vibrato_hz * most && wanted >= self.vibrato_hz / most;
                        self.vibrato_hz = if settled {
                            wanted
                        } else {
                            wanted.clamp(self.vibrato_hz / most, self.vibrato_hz * most)
                        };
                        let omega = tau * self.vibrato_hz;
                        let target = vibrato_swing(
                            f.vibrato.depth_cents,
                            if settled { after } else { self.vibrato_hz },
                            self.rate,
                        );
                        self.vibrato_swing = if self.vibrato_swing.is_nan() {
                            target
                        } else {
                            slew(self.vibrato_swing, target)
                        };
                        let offset = 2.0 + self.vibrato_swing * (1.0 - self.vibrato_phase.cos());
                        let wet = self.vibrato.read(offset);
                        self.vibrato.write(x);
                        self.vibrato_phase = (self.vibrato_phase + omega / self.rate) % tau;
                        x = blend(x, wet, p.vibrato.enabled, f.vibrato.enabled);
                    } else {
                        // Switched off, it starts afresh at its settings when switched on again, as a new configuration does.
                        (self.vibrato_swing, self.vibrato_hz) = (f64::NAN, f64::NAN);
                    }
                }
                Stage::Phaser => {
                    if f.phaser.enabled || p.phaser.enabled && t < 1.0 {
                        let depth = lerp(p.phaser.depth, f.phaser.depth);
                        let feedback = lerp(p.phaser.feedback, f.phaser.feedback);
                        let mix = lerp(p.phaser.mix, f.phaser.mix) as f32;
                        // All eight stages always run, so a new stage count crossfades between fresh taps instead of clicking.
                        let taps = [p.phaser.stages as usize - 1, f.phaser.stages as usize - 1];
                        let mut wet = [0.0f32; 2];
                        for c in 0..2 {
                            // The channels sweep a quarter cycle apart; the notches move between 200 Hz and 6.4 kHz.
                            let sweep =
                                (1.0 - (self.phaser_phase + c as f64 * tau / 4.0).cos()) / 2.0;
                            let hz = (200.0 * 2f64.powf(5.0 * depth * sweep)).min(self.rate * 0.45);
                            let k = (std::f64::consts::PI * hz / self.rate).tan();
                            let a = (k - 1.0) / (k + 1.0);
                            let mut y = x[c] as f64 + feedback * self.phaser_last[c];
                            let mut tapped = [0.0; 2];
                            for (index, stage) in self.phaser[c].iter_mut().enumerate() {
                                let out = flush(a * y + stage[0] - a * stage[1]);
                                stage[0] = y;
                                stage[1] = out;
                                y = out;
                                for (which, tap) in taps.iter().enumerate() {
                                    if index == *tap {
                                        tapped[which] = out;
                                    }
                                }
                            }
                            let out = lerp(tapped[0], tapped[1]);
                            self.phaser_last[c] = flush(out);
                            // Feedback raises the in-phase gain to 1/(1-feedback); scaling keeps the wet level at the input's.
                            wet[c] = (out * (1.0 - feedback)) as f32;
                        }
                        self.phaser_phase = (self.phaser_phase
                            + tau
                                * lerp(
                                    hz(p.phaser.rate_hz, p.phaser.sync_quarter_notes, 0.05, 5.0),
                                    hz(f.phaser.rate_hz, f.phaser.sync_quarter_notes, 0.05, 5.0),
                                )
                                / self.rate)
                            % tau;
                        x = blend(
                            x,
                            std::array::from_fn(|c| x[c] * (1.0 - mix) + wet[c] * mix),
                            p.phaser.enabled,
                            f.phaser.enabled,
                        );
                    }
                }
                Stage::Flanger => {
                    if f.flanger.enabled || p.flanger.enabled && t < 1.0 {
                        // The delay sweeps from 0.1 ms up to 0.1 ms plus the depth.
                        self.flanger_swing =
                            slew(self.flanger_swing, self.rate * f.flanger.depth_ms * 0.001);
                        let offset = self.rate * 0.0001
                            + self.flanger_swing * (1.0 - self.flanger_phase.cos()) / 2.0;
                        let echo = self.flanger.read(offset);
                        let feedback = lerp(p.flanger.feedback, f.flanger.feedback) as f32;
                        self.flanger.write(std::array::from_fn(|c| {
                            flush((x[c] + echo[c] * feedback) as f64) as f32
                        }));
                        // The comb peaks at 1/(1-|feedback|); scaling keeps the wet level at the input's.
                        let wet: [f32; 2] = echo.map(|v| v * (1.0 - feedback.abs()));
                        self.flanger_phase = (self.flanger_phase
                            + tau
                                * lerp(
                                    hz(p.flanger.rate_hz, p.flanger.sync_quarter_notes, 0.05, 5.0),
                                    hz(f.flanger.rate_hz, f.flanger.sync_quarter_notes, 0.05, 5.0),
                                )
                                / self.rate)
                            % tau;
                        let mix = lerp(p.flanger.mix, f.flanger.mix) as f32;
                        x = blend(
                            x,
                            std::array::from_fn(|c| x[c] * (1.0 - mix) + wet[c] * mix),
                            p.flanger.enabled,
                            f.flanger.enabled,
                        );
                    }
                }
                Stage::Chorus => {
                    if f.chorus.enabled || p.chorus.enabled && t < 1.0 {
                        let depth = self.rate * lerp(p.chorus.depth_ms, f.chorus.depth_ms) * 0.001;
                        let wet: [f32; 2] = std::array::from_fn(|c| {
                            self.chorus.read(
                                self.rate * 0.012
                                    + depth * (1.0 + (self.phase + c as f64 * 1.2).sin()) * 0.5,
                            )[c]
                        });
                        self.chorus.write(x);
                        self.phase = (self.phase
                            + std::f64::consts::TAU
                                * lerp(
                                    hz(p.chorus.rate_hz, p.chorus.sync_quarter_notes, 0.1, 8.0),
                                    hz(f.chorus.rate_hz, f.chorus.sync_quarter_notes, 0.1, 8.0),
                                )
                                / self.rate)
                            % std::f64::consts::TAU;
                        let mix = lerp(p.chorus.mix, f.chorus.mix) as f32;
                        x = blend(
                            x,
                            std::array::from_fn(|c| x[c] * (1.0 - mix) + wet[c] * mix),
                            p.chorus.enabled,
                            f.chorus.enabled,
                        );
                    }
                }
                Stage::Tremolo => {
                    if f.tremolo.enabled || p.tremolo.enabled && t < 1.0 {
                        let wave = |shape: &str, phase: f64| {
                            if shape == "square" {
                                // A steep but smooth square avoids clicks at its edges.
                                (1.0 - (8.0 * phase.cos()).tanh() / 8f64.tanh()) / 2.0
                            } else {
                                (1.0 - phase.cos()) / 2.0
                            }
                        };
                        let dip = lerp(
                            wave(&p.tremolo.shape, self.tremolo_phase),
                            wave(&f.tremolo.shape, self.tremolo_phase),
                        );
                        let gain = (1.0 - lerp(p.tremolo.depth, f.tremolo.depth) * dip) as f32;
                        self.tremolo_phase = (self.tremolo_phase
                            + tau
                                * lerp(
                                    hz(p.tremolo.rate_hz, p.tremolo.sync_quarter_notes, 0.1, 20.0),
                                    hz(f.tremolo.rate_hz, f.tremolo.sync_quarter_notes, 0.1, 20.0),
                                )
                                / self.rate)
                            % tau;
                        x = blend(x, x.map(|v| v * gain), p.tremolo.enabled, f.tremolo.enabled);
                    }
                }
                Stage::Delay => {
                    if f.delay.enabled || p.delay.enabled && t < 1.0 {
                        let bpm = if bpm.is_finite() && bpm > 0.0 {
                            bpm
                        } else {
                            120.0
                        };
                        // Extremely slow tempos retain a bounded echo rather than rejecting the score.
                        let offset = (self.rate * 60.0 / bpm
                            * lerp(p.delay.quarter_notes, f.delay.quarter_notes))
                        .min((self.delay.frames.len() - 2) as f64);
                        let shapes = self.delay_shapes;
                        // How much of the tape or analog sound plays: 0 for digital on both sides, so digital echoes stay
                        // exact, and crossfading during a change to or from digital.
                        let colored = lerp(
                            if shapes[0].colored { 1.0 } else { 0.0 },
                            if shapes[1].colored { 1.0 } else { 0.0 },
                        );
                        let mut wet = self.delay.read(offset);
                        if colored > 0.0 {
                            // A digital side takes the other side's character, so only the amount crossfades.
                            let side = |s: usize| {
                                if shapes[s].colored {
                                    shapes[s]
                                } else {
                                    shapes[1 - s]
                                }
                            };
                            let (a, b) = (side(0), side(1));
                            let [low, high, drive] = [
                                lerp(a.low, b.low),
                                lerp(a.high, b.high),
                                lerp(a.drive, b.drive),
                            ];
                            let wander = (0..2)
                                .map(|i| lerp(a.depth[i], b.depth[i]) * self.delay_phase[i].sin())
                                .sum::<f64>();
                            for i in 0..2 {
                                self.delay_phase[i] = (self.delay_phase[i]
                                    + lerp(a.step[i], b.step[i]))
                                    % std::f64::consts::TAU;
                            }
                            let moved = self.delay.read(offset + wander);
                            for c in 0..2 {
                                let [lp, hp] = &mut self.delay_filters[c];
                                *lp = flush(*lp + low * (moved[c] as f64 - *lp));
                                *hp = flush(*hp + high * (*lp - *hp));
                                let tone = (drive * (*lp - *hp)).tanh() / drive;
                                wet[c] = (wet[c] as f64 + (tone - wet[c] as f64) * colored) as f32;
                            }
                        }
                        let feedback = lerp(p.delay.feedback, f.delay.feedback) as f32;
                        self.delay
                            .write(std::array::from_fn(|c| x[c] + wet[c] * feedback));
                        let mix = lerp(p.delay.mix, f.delay.mix) as f32;
                        x = blend(
                            x,
                            std::array::from_fn(|c| x[c] * (1.0 - mix) + wet[c] * mix),
                            p.delay.enabled,
                            f.delay.enabled,
                        );
                    }
                }
                Stage::Reverb => {
                    let running = f.reverb.enabled || p.reverb.enabled && t < 1.0;
                    let shapes = self.reverb_shapes;
                    // The models that run this frame: one with both sides' settings blended, or during a change of model
                    // each side that is on with its own settings, crossfaded.
                    let same = shapes[0].model == shapes[1].model;
                    let side_on = [p.reverb.enabled && t < 1.0, f.reverb.enabled];
                    let needed = |model: usize| {
                        running
                            && if same {
                                shapes[1].model == model
                            } else {
                                (0..2).any(|s| side_on[s] && shapes[s].model == model)
                            }
                    };
                    if needed(0) && !self.reverb_live {
                        for line in &mut self.reverb {
                            line.reset();
                        }
                        self.reverb_damp = [[0.0; 2]; 4];
                    }
                    self.reverb_live = needed(0);
                    for tank in self.reverb_tanks.iter_mut() {
                        let need = needed(tank.family + 1);
                        if need && !tank.live {
                            tank.reset();
                        }
                        tank.live = need;
                    }
                    if running && same {
                        let wet = if shapes[1].model == 0 {
                            room_reverb(
                                &mut self.reverb,
                                &mut self.reverb_damp,
                                x,
                                lerp(p.reverb.room, f.reverb.room),
                                lerp(p.reverb.damping, f.reverb.damping),
                            )
                        } else {
                            let feedback = std::array::from_fn(|i| {
                                lerp(shapes[0].feedback[i], shapes[1].feedback[i])
                            });
                            self.reverb_tanks[shapes[1].model - 1]
                                .run(
                                    (x[0] as f64 + x[1] as f64) * 0.5,
                                    feedback,
                                    std::array::from_fn(|i| {
                                        lerp(shapes[0].cut[i], shapes[1].cut[i])
                                    }),
                                )
                                .map(|v| v as f32)
                        };
                        let mix = lerp(p.reverb.mix, f.reverb.mix) as f32;
                        x = blend(
                            x,
                            std::array::from_fn(|c| x[c] * (1.0 - mix) + wet[c] * mix),
                            p.reverb.enabled,
                            f.reverb.enabled,
                        );
                    } else if running {
                        let sides = [
                            (p.reverb.room, p.reverb.damping, p.reverb.mix),
                            (f.reverb.room, f.reverb.damping, f.reverb.mix),
                        ];
                        let out: [[f32; 2]; 2] = std::array::from_fn(|s| {
                            if !side_on[s] {
                                return x;
                            }
                            let wet = if shapes[s].model == 0 {
                                room_reverb(
                                    &mut self.reverb,
                                    &mut self.reverb_damp,
                                    x,
                                    sides[s].0,
                                    sides[s].1,
                                )
                            } else {
                                self.reverb_tanks[shapes[s].model - 1]
                                    .run(
                                        (x[0] as f64 + x[1] as f64) * 0.5,
                                        shapes[s].feedback,
                                        shapes[s].cut,
                                    )
                                    .map(|v| v as f32)
                            };
                            let mix = sides[s].2 as f32;
                            std::array::from_fn(|c| x[c] * (1.0 - mix) + wet[c] * mix)
                        });
                        x = std::array::from_fn(|c| {
                            lerp(out[0][c] as f64, out[1][c] as f64) as f32
                        });
                    }
                }
            }
        }
        if let Some(gain) = duck {
            x = x.map(|v| v * gain);
        }
        self.ramp_left = self.ramp_left.saturating_sub(1);
        x.map(|v| {
            if v.is_finite() {
                v.clamp(-64.0, 64.0)
            } else {
                0.0
            }
        })
    }
    pub fn reset(&mut self) {
        self.gate_envelope = 1.0;
        self.compressor_envelope = 0.0;
        self.amp_dc = [0.0; 2];
        self.amp_previous_input = [0.0; 2];
        self.amp_anti_alias = [[0.0; 3]; 2];
        for b in &mut self.amp_tone {
            b.reset();
        }
        self.amp_tone_db = amp_tone(&self.settings.amp);
        for b in &mut self.cabinet {
            b.reset();
        }
        for b in &mut self.eq {
            b.reset();
        }
        for b in &mut self.graphic_eq {
            b.reset();
        }
        self.chorus.reset();
        self.delay.reset();
        self.delay_filters = [[0.0; 2]; 2];
        self.delay_phase = [0.0; 2];
        for line in &mut self.reverb {
            line.reset();
        }
        self.reverb_damp = [[0.0; 2]; 4];
        for tank in self.reverb_tanks.iter_mut() {
            tank.reset();
        }
        self.phase = 0.0;
        self.vibrato.reset();
        self.vibrato_phase = 0.0;
        self.vibrato_swing = f64::NAN;
        self.vibrato_hz = f64::NAN;
        self.flanger_swing = self.rate * self.settings.flanger.depth_ms * 0.001;
        self.phaser = [[[0.0; 2]; 8]; 2];
        self.phaser_last = [0.0; 2];
        self.phaser_phase = 0.0;
        self.flanger.reset();
        self.flanger_phase = 0.0;
        self.tremolo_phase = 0.0;
        self.wah = [[0.0; 2]; 2];
        self.wah_envelope = 0.0;
        self.wah_position = wah_target(&self.settings.wah, 0.0);
        self.octaver.reset();
        self.octaver_phase = [Shifter::default(); 2];
        self.pitch.reset();
        self.pitch_phase = Shifter::default();
        self.drive_previous_input = [0.0; 2];
        self.drive_anti_alias = [[0.0; 3]; 2];
        self.drive_dc = [0.0; 2];
        self.drive_tone = [[0.0; 2]; 2];
        self.drive_envelope = 0.0;
        for shape in &mut self.microphone_shapes {
            shape.filters.iter_mut().for_each(Biquad::reset);
        }
        self.microphone_room.reset();
        self.microphone_age = self.rate;
        self.microphone_live = self.settings.microphone.enabled;
        self.chain = self.chain_target;
        self.reorder_left = 0;
        // A board that is not playing is never heard again: one added again starts afresh.
        if let Some(second) = self
            .second
            .as_mut()
            .filter(|_| self.settings.second.is_some())
        {
            second.reset();
        }
        self.second_gain = if self.settings.second.is_some() {
            1.0
        } else {
            0.0
        };
    }
}

pub(crate) struct BackingFilterDsp {
    filter: Option<Biquad>,
}
impl BackingFilterDsp {
    pub(crate) fn new(mode: crate::settings::BackingFilter, rate: u32) -> Result<Self, String> {
        use crate::settings::BackingFilter;
        if !(8_000..=192_000).contains(&rate) {
            return Err("Invalid backing filter sample rate.".into());
        }
        let mut filter = Biquad::default();
        match mode {
            BackingFilter::None => return Ok(Self { filter: None }),
            BackingFilter::BassEnhance => filter.shelf(180.0, 6.0, rate as f64, false),
            BackingFilter::BassAttenuation => filter.shelf(180.0, -6.0, rate as f64, false),
            BackingFilter::MediumEnhance => filter.peak(1000.0, 6.0, rate as f64),
            BackingFilter::MediumAttenuation => filter.peak(1000.0, -6.0, rate as f64),
            BackingFilter::HighEnhance => filter.shelf(4000.0, 6.0, rate as f64, true),
            BackingFilter::HighAttenuation => filter.shelf(4000.0, -6.0, rate as f64, true),
        }
        Ok(Self {
            filter: Some(filter),
        })
    }
    pub(crate) fn process(&mut self, frame: [f32; 2]) -> [f32; 2] {
        match &mut self.filter {
            Some(filter) => filter.process(frame),
            None => frame,
        }
    }
    pub(crate) fn reset(&mut self) {
        if let Some(filter) = &mut self.filter {
            filter.reset();
        }
    }
}
#[cfg(test)]
mod backing_filter_tests {
    use super::BackingFilterDsp;
    use crate::settings::BackingFilter;

    const MODES: [BackingFilter; 7] = [
        BackingFilter::None,
        BackingFilter::BassEnhance,
        BackingFilter::BassAttenuation,
        BackingFilter::MediumEnhance,
        BackingFilter::MediumAttenuation,
        BackingFilter::HighEnhance,
        BackingFilter::HighAttenuation,
    ];
    const PATTERNS: [[f32; 2]; 4] = [[1.0, 1.0], [1.0, -1.0], [1.0, 0.0], [0.0, 1.0]];

    // Measure settled PCM energy, without examining filter coefficients.
    fn response(mode: BackingFilter, target: usize, sign: f64) {
        for rate in [44_100, 48_000] {
            for pattern in PATTERNS {
                for (band, hz) in [80.0, 1000.0, 10000.0].into_iter().enumerate() {
                    let mut dsp = BackingFilterDsp::new(mode, rate).unwrap();
                    let mut input_energy = 0.0;
                    let mut output_energy = [0.0; 2];
                    for i in 0..rate {
                        let s = (0.05 * (std::f64::consts::TAU * hz * i as f64 / rate as f64).sin())
                            as f32;
                        let output = dsp.process(pattern.map(|p| p * s));
                        assert!(output.iter().all(|v| v.is_finite()));
                        if pattern[0] == 0.0 {
                            assert_eq!(output[0], 0.0);
                        }
                        if pattern[1] == 0.0 {
                            assert_eq!(output[1], 0.0);
                        }
                        if pattern[0] == pattern[1] {
                            assert_eq!(output[0], output[1]);
                        }
                        if pattern[0] == -pattern[1] {
                            assert_eq!(output[0], -output[1]);
                        }
                        if i >= rate / 2 {
                            input_energy += (s as f64).powi(2);
                            for c in 0..2 {
                                output_energy[c] += (output[c] as f64).powi(2);
                            }
                        }
                    }
                    for c in 0..2 {
                        if pattern[c] == 0.0 {
                            continue;
                        }
                        let db = 10.0 * (output_energy[c] / input_energy).log10();
                        if band == target {
                            assert!(
                                (4.0..=7.0).contains(&(db * sign)),
                                "{mode:?} {rate}Hz {hz}Hz {pattern:?} channel {c}: {db}dB"
                            );
                        } else {
                            assert!(db.abs() < 1.0, "{mode:?} {rate}Hz {hz}Hz: {db}dB");
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn bass_enhance_response() {
        response(BackingFilter::BassEnhance, 0, 1.0);
    }
    #[test]
    fn bass_attenuation_response() {
        response(BackingFilter::BassAttenuation, 0, -1.0);
    }
    #[test]
    fn medium_enhance_response() {
        response(BackingFilter::MediumEnhance, 1, 1.0);
    }
    #[test]
    fn medium_attenuation_response() {
        response(BackingFilter::MediumAttenuation, 1, -1.0);
    }
    #[test]
    fn high_enhance_response() {
        response(BackingFilter::HighEnhance, 2, 1.0);
    }
    #[test]
    fn high_attenuation_response() {
        response(BackingFilter::HighAttenuation, 2, -1.0);
    }

    #[test]
    fn none_is_bit_exact_bypass() {
        for rate in [8_000, 44_100, 48_000, 192_000] {
            let mut dsp = BackingFilterDsp::new(BackingFilter::None, rate).unwrap();
            for frame in [
                [0.0, -0.0],
                [0.125, -0.3],
                [2.0, -4.0],
                [f32::MIN_POSITIVE, f32::from_bits(1)],
            ] {
                assert_eq!(
                    dsp.process(frame).map(f32::to_bits),
                    frame.map(f32::to_bits)
                );
            }
            dsp.reset();
            assert_eq!(dsp.process([0.25, -0.5]), [0.25, -0.5]);
        }
    }
    #[test]
    fn reset_matches_fresh_filter() {
        for rate in [44_100, 48_000] {
            for mode in MODES {
                let mut used = BackingFilterDsp::new(mode, rate).unwrap();
                for i in 0..1000 {
                    used.process([(i as f32 * 0.17).sin() * 0.1, 0.0]);
                }
                used.reset();
                let mut fresh = BackingFilterDsp::new(mode, rate).unwrap();
                for i in 0..2000 {
                    let frame = [(i as f32 * 0.23).sin() * 0.1, (i as f32 * 0.31).cos() * 0.1];
                    assert_eq!(used.process(frame), fresh.process(frame));
                }
            }
        }
    }
    #[test]
    fn supported_boundary_rates_remain_finite() {
        for rate in [8_000, 192_000] {
            for mode in MODES {
                let mut dsp = BackingFilterDsp::new(mode, rate).unwrap();
                for i in 0..rate {
                    let input = if i == 0 { [0.1, -0.2] } else { [0.0; 2] };
                    assert!(dsp.process(input).iter().all(|v| v.is_finite()));
                }
            }
        }
    }
    #[test]
    fn rejects_unsupported_rates() {
        for mode in MODES {
            for rate in [0, 1, 7_999, 192_001, u32::MAX] {
                assert!(BackingFilterDsp::new(mode, rate).is_err());
            }
        }
    }
}
