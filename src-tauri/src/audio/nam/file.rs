//! Bounded parser for Neural Amp Modeler `.nam` files.
//!
//! Supports WaveNet "A1" (versions 0.5.x to 0.7.x) and LSTM. Anything newer in
//! the WaveNet family (A2 keys) is refused. The expected weight count is
//! computed from the config, and must equal what the forward pass consumes,
//! before the `weights` array is converted.

use super::cost::{max_receptive_field, within_budget};
use super::raw::{Scalar, read_root};
use serde_json::{Map, Value};

/// Largest file accepted, in bytes.
pub const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
/// Deepest JSON nesting accepted (every `[` and `{` counts).
pub const MAX_JSON_DEPTH: usize = 32;
pub const MAX_LAYER_ARRAYS: usize = 4;
pub const MAX_LAYERS_PER_ARRAY: usize = 32;
pub const MAX_CHANNELS: usize = 64;
pub const MAX_HEAD_SIZE: usize = 64;
pub const MAX_KERNEL_SIZE: usize = 8;
pub const MAX_DILATION: usize = 4096;
/// Cap on the sum over layers of `channels * (kernel_size - 1) * dilation`: the floats of history the model keeps.
/// The standard official A1 WaveNet needs 49,104 (lite, feather and nano fewer), so this is 2.7 times that. It is a
/// memory bound; prewarm, which feeds the receptive field of zeros through the model, is bounded by the receptive
/// field cap (`max_receptive_field`, 0.6 s of the model's rate) and the cost budget in `cost`: at most 1.26 billion
/// cost units, about 0.18 s, off the audio thread. The old 4,000,000 bounded neither.
pub const MAX_RING_FLOATS: usize = 131_072;
pub const MAX_WEIGHTS: usize = 2_000_000;
pub const MAX_LSTM_LAYERS: usize = 4;
pub const MAX_LSTM_HIDDEN: usize = 64;
/// Rate assumed when the file has no usable `sample_rate`.
pub const DEFAULT_MODEL_RATE: u32 = 48_000;
const MIN_MODEL_RATE: f64 = 8_000.0;
const MAX_MODEL_RATE: f64 = 384_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activation {
    Tanh,
    Hardtanh,
    Fasttanh,
    ReLU,
    Sigmoid,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LayerArraySpec {
    pub input_size: usize,
    pub condition_size: usize,
    pub channels: usize,
    pub head_size: usize,
    pub kernel_size: usize,
    pub dilations: Vec<usize>,
    pub gated: bool,
    pub head_bias: bool,
    pub activation: Activation,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WaveNetSpec {
    pub arrays: Vec<LayerArraySpec>,
    /// NAM Core multiplies the final output by the LAST WEIGHT in the file,
    /// not by the `head_scale` in the config. This holds `weights.last()`.
    /// The weight itself stays at the end of `NamFile::weights`.
    pub head_scale: f32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LstmSpec {
    pub num_layers: usize,
    pub input_size: usize,
    pub hidden_size: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NamSpec {
    WaveNet(WaveNetSpec),
    Lstm(LstmSpec),
}

#[derive(Debug, Clone, PartialEq)]
pub struct NamFile {
    pub(crate) spec: NamSpec,
    pub(crate) weights: Vec<f32>,
    pub(crate) model_rate: u32,
    /// WaveNet: `1 + sum(dilation * (kernel_size - 1))` over every layer.
    /// LSTM: 0 (the state is carried, so there is no fixed window; the
    /// engine prewarms for half a second of the model rate instead).
    pub(crate) receptive_field: usize,
}

impl NamFile {
    pub fn spec(&self) -> &NamSpec {
        &self.spec
    }

    pub fn model_rate(&self) -> u32 {
        self.model_rate
    }

    pub fn receptive_field(&self) -> usize {
        self.receptive_field
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NamError {
    TooLarge,
    NotJson,
    TooDeep,
    UnsupportedVersion(String),
    UnsupportedArchitecture(String),
    Invalid(&'static str),
    WeightCount {
        expected: usize,
        found: usize,
    },
    NonFinite,
    /// Within every cap, but needs more multiply-adds per second than `MAX_MACS_PER_SECOND`.
    TooHeavy,
}

impl std::fmt::Display for NamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NamError::TooLarge => write!(f, "NAM file is larger than {MAX_FILE_BYTES} bytes"),
            NamError::NotJson => write!(f, "NAM file is not valid JSON"),
            NamError::TooDeep => write!(f, "NAM file is nested too deeply"),
            NamError::UnsupportedVersion(v) => write!(f, "unsupported NAM file version {v}"),
            NamError::UnsupportedArchitecture(a) => {
                write!(f, "unsupported NAM architecture: {a}")
            }
            NamError::Invalid(why) => write!(f, "invalid NAM file: {why}"),
            NamError::WeightCount { expected, found } => {
                write!(f, "NAM file has {found} weights, expected {expected}")
            }
            NamError::NonFinite => write!(f, "NAM file has a weight that is not finite"),
            NamError::TooHeavy => write!(f, "This capture is too heavy to play in real time"),
        }
    }
}

impl std::error::Error for NamError {}

pub fn parse_nam(bytes: &[u8]) -> Result<NamFile, NamError> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(NamError::TooLarge);
    }
    if depth_exceeds_cap(bytes) {
        return Err(NamError::TooDeep);
    }
    let raw = read_root(bytes)?;

    check_version(raw.version.as_ref())?;
    let architecture = match &raw.architecture {
        Some(Scalar::Str(name)) => name.as_str(),
        _ => return Err(NamError::Invalid("architecture is missing")),
    };
    let config = raw
        .config
        .as_ref()
        .and_then(Value::as_object)
        .ok_or(NamError::Invalid("config is missing"))?;
    let weights = raw
        .weights
        .as_ref()
        .ok_or(NamError::Invalid("weights is missing"))?;
    let model_rate = model_rate(raw.sample_rate.as_ref());

    let (mut spec, expected, receptive_field) = match architecture {
        "WaveNet" => {
            let (spec, expected, rf) = parse_wavenet(config)?;
            (NamSpec::WaveNet(spec), expected, rf)
        }
        "LSTM" => {
            let (spec, expected) = parse_lstm(config)?;
            (NamSpec::Lstm(spec), expected, 0)
        }
        other => {
            return Err(NamError::UnsupportedArchitecture(
                other.chars().take(32).collect(),
            ));
        }
    };

    if expected > MAX_WEIGHTS {
        return Err(NamError::Invalid("too many weights"));
    }
    // Memory is bounded by the caps; time is bounded here, from the architecture, before the weights are used.
    if !within_budget(&spec, model_rate) || receptive_field > max_receptive_field(model_rate) {
        return Err(NamError::TooHeavy);
    }
    if weights.len() != expected {
        return Err(NamError::WeightCount {
            expected,
            found: weights.len(),
        });
    }
    let weights = raw.weights.unwrap_or_default();
    if let NamSpec::WaveNet(wavenet) = &mut spec {
        wavenet.head_scale = weights.last().copied().unwrap_or(0.0);
    }

    Ok(NamFile {
        spec,
        weights,
        model_rate,
        receptive_field,
    })
}

/// Cheap scan of brackets outside strings, so a hostile nesting never reaches
/// the real parser.
fn depth_exceeds_cap(bytes: &[u8]) -> bool {
    let (mut depth, mut in_string, mut escaped) = (0usize, false, false);
    for &b in bytes {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                if depth > MAX_JSON_DEPTH {
                    return true;
                }
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    false
}

/// Core supports 0.5.0 up to and including 0.7.x.
fn check_version(version: Option<&Scalar>) -> Result<(), NamError> {
    let text = match version {
        None => return Err(NamError::Invalid("version is missing")),
        Some(Scalar::Str(text)) => text,
        Some(_) => return Err(NamError::UnsupportedVersion("(not a string)".into())),
    };
    let shown = || text.chars().take(32).collect::<String>();
    if text.len() > 32 {
        return Err(NamError::UnsupportedVersion(shown()));
    }
    let parts: Vec<&str> = text.splitn(4, '.').collect();
    let numbers: Option<Vec<u32>> = if parts.len() == 3 {
        parts
            .iter()
            .map(|p| {
                if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) {
                    p.parse().ok()
                } else {
                    None
                }
            })
            .collect()
    } else {
        None
    };
    match numbers.as_deref() {
        Some([0, minor, _]) if (5..=7).contains(minor) => Ok(()),
        _ => Err(NamError::UnsupportedVersion(shown())),
    }
}

fn model_rate(value: Option<&Scalar>) -> u32 {
    match value {
        Some(Scalar::Num(r)) if r.is_finite() && (MIN_MODEL_RATE..=MAX_MODEL_RATE).contains(r) => {
            r.round() as u32
        }
        _ => DEFAULT_MODEL_RATE,
    }
}

fn unsupported(what: String) -> NamError {
    NamError::UnsupportedArchitecture(what)
}

fn req_usize(
    obj: &Map<String, Value>,
    key: &str,
    missing: &'static str,
) -> Result<usize, NamError> {
    obj.get(key)
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or(NamError::Invalid(missing))
}

fn parse_wavenet(config: &Map<String, Value>) -> Result<(WaveNetSpec, usize, usize), NamError> {
    for (key, value) in config {
        if value.is_null() {
            continue;
        }
        match key.as_str() {
            "layers" | "head_scale" | "head" | "condition_dsp" => {}
            other => {
                return Err(unsupported(format!(
                    "unknown WaveNet config key {}",
                    other.chars().take(32).collect::<String>()
                )));
            }
        }
    }
    if config.get("head").is_some_and(|v| !v.is_null()) {
        return Err(unsupported("post-stack head".into()));
    }
    if config.get("condition_dsp").is_some_and(|v| !v.is_null()) {
        return Err(unsupported("condition_dsp".into()));
    }
    // The value that counts is the last weight; the config copy must still be sane.
    match config.get("head_scale") {
        None | Some(Value::Null) => {}
        Some(v) => {
            let scale = v
                .as_f64()
                .ok_or(NamError::Invalid("head_scale is not a number"))?;
            if !(scale as f32).is_finite() {
                return Err(NamError::NonFinite);
            }
        }
    }
    let layers = config
        .get("layers")
        .and_then(Value::as_array)
        .ok_or(NamError::Invalid("layers is missing"))?;
    if layers.is_empty() || layers.len() > MAX_LAYER_ARRAYS {
        return Err(NamError::Invalid("layer array count out of range"));
    }

    let mut arrays: Vec<LayerArraySpec> = Vec::with_capacity(layers.len());
    for (i, layer) in layers.iter().enumerate() {
        let layer = layer
            .as_object()
            .ok_or(NamError::Invalid("a layer array is not an object"))?;
        let spec = parse_layer_array(layer)?;
        if i == 0 {
            if spec.input_size != 1 {
                return Err(NamError::Invalid("first layer array input_size is not 1"));
            }
        } else {
            let prev = &arrays[i - 1];
            if spec.input_size != prev.channels {
                return Err(NamError::Invalid(
                    "layer array input_size differs from the previous channels",
                ));
            }
            if spec.channels != prev.head_size {
                return Err(NamError::Invalid(
                    "layer array channels differ from the previous head_size",
                ));
            }
        }
        arrays.push(spec);
    }
    if arrays.last().is_some_and(|a| a.head_size != 1) {
        return Err(NamError::Invalid("last layer array head_size is not 1"));
    }

    let mut ring_floats = 0usize;
    let mut expected = 0usize;
    let mut span = 0usize;
    for a in &arrays {
        let g = if a.gated { 2 } else { 1 };
        let c = a.channels;
        expected += c * a.input_size; // rechannel
        for &d in &a.dilations {
            let reach = d * (a.kernel_size - 1);
            span += reach;
            ring_floats += c * reach;
            expected += g * c * c * a.kernel_size + g * c; // conv + bias
            expected += g * c * a.condition_size; // input mixin
            expected += c * c + c; // layer 1x1 + bias
        }
        expected += a.head_size * c + if a.head_bias { a.head_size } else { 0 };
    }
    if ring_floats > MAX_RING_FLOATS {
        return Err(NamError::Invalid("history buffers exceed the cap"));
    }
    expected += 1; // head_scale

    // head_scale is filled from the last weight once the weights are known.
    Ok((
        WaveNetSpec {
            arrays,
            head_scale: 0.0,
        },
        expected,
        1 + span,
    ))
}

fn parse_layer_array(obj: &Map<String, Value>) -> Result<LayerArraySpec, NamError> {
    for (key, value) in obj {
        if value.is_null() {
            continue;
        }
        match key.as_str() {
            "input_size" | "condition_size" | "channels" | "head_size" | "kernel_size" | "head"
            | "dilations" | "activation" | "gated" | "head_bias" | "bottleneck"
            | "groups_input" | "groups_input_mixin" | "layer1x1" | "head1x1" | "gating_mode" => {}
            "kernel_sizes" => return Err(unsupported("per-layer kernel_sizes".into())),
            other => {
                return Err(unsupported(format!(
                    "unknown layer array key {}",
                    other.chars().take(32).collect::<String>()
                )));
            }
        }
    }

    let channels = req_usize(obj, "channels", "channels is missing")?;
    let (head_size, head_bias) = parse_layer_head(obj)?;
    let input_size = req_usize(obj, "input_size", "input_size is missing")?;
    let condition_size = req_usize(obj, "condition_size", "condition_size is missing")?;
    let kernel_size = req_usize(obj, "kernel_size", "kernel_size is missing")?;
    if !(1..=MAX_CHANNELS).contains(&channels) {
        return Err(NamError::Invalid("channels out of range"));
    }
    if !(1..=MAX_HEAD_SIZE).contains(&head_size) {
        return Err(NamError::Invalid("head_size out of range"));
    }
    if !(1..=MAX_KERNEL_SIZE).contains(&kernel_size) {
        return Err(NamError::Invalid("kernel_size out of range"));
    }
    if condition_size != 1 {
        return Err(NamError::Invalid("condition_size is not 1"));
    }
    if !(1..=MAX_CHANNELS).contains(&input_size) {
        return Err(NamError::Invalid("input_size out of range"));
    }

    // A2 keys: accepted only when they spell out the A1 defaults.
    if let Some(b) = obj.get("bottleneck").filter(|v| !v.is_null()) {
        if b.as_u64() != Some(channels as u64) {
            return Err(unsupported("bottleneck different from channels".into()));
        }
    }
    for key in ["groups_input", "groups_input_mixin"] {
        if let Some(g) = obj.get(key).filter(|v| !v.is_null()) {
            if g.as_u64() != Some(1) {
                return Err(unsupported(format!("grouped convolution ({key})")));
            }
        }
    }
    if let Some(l) = obj.get("layer1x1").filter(|v| !v.is_null()) {
        let l = l
            .as_object()
            .ok_or_else(|| unsupported("layer1x1 is not an object".into()))?;
        if l.keys().any(|k| k != "active" && k != "groups")
            || l.get("active").is_some_and(|a| a.as_bool() != Some(true))
            || l.get("groups").is_some_and(|g| g.as_u64() != Some(1))
        {
            return Err(unsupported("layer1x1 other than active, groups 1".into()));
        }
    }
    if let Some(h) = obj.get("head1x1").filter(|v| !v.is_null()) {
        let inactive = h
            .as_object()
            .is_some_and(|h| h.get("active").and_then(Value::as_bool) == Some(false));
        if !inactive {
            return Err(unsupported("head1x1".into()));
        }
    }

    let gated_legacy = match obj.get("gated") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_bool()
                .ok_or(NamError::Invalid("gated is not a boolean"))?,
        ),
    };
    let gated_mode = match obj.get("gating_mode") {
        None | Some(Value::Null) => None,
        Some(v) => Some(parse_gating_mode(v)?),
    };
    let gated = match (gated_legacy, gated_mode) {
        (Some(a), Some(b)) if a != b => {
            return Err(NamError::Invalid("gated and gating_mode disagree"));
        }
        (Some(a), _) => a,
        (None, Some(b)) => b,
        (None, None) => false,
    };

    let activation = parse_activation(obj.get("activation"))?;

    let dilations_json = obj
        .get("dilations")
        .and_then(Value::as_array)
        .ok_or(NamError::Invalid("dilations is missing"))?;
    if dilations_json.is_empty() || dilations_json.len() > MAX_LAYERS_PER_ARRAY {
        return Err(NamError::Invalid("layer count out of range"));
    }
    let mut dilations = Vec::with_capacity(dilations_json.len());
    for d in dilations_json {
        let d = d
            .as_u64()
            .filter(|d| (1..=MAX_DILATION as u64).contains(d))
            .ok_or(NamError::Invalid("dilation out of range"))?;
        dilations.push(d as usize);
    }

    Ok(LayerArraySpec {
        input_size,
        condition_size,
        channels,
        head_size,
        kernel_size,
        dilations,
        gated,
        head_bias,
        activation,
    })
}

/// The head of a layer array: legacy `head_size` and `head_bias`, or the nested
/// `head` {out_channels, kernel_size, bias} that current trainer exports write.
/// Only a kernel of 1 maps onto the A1 layout; if both forms are present they
/// must agree.
fn parse_layer_head(obj: &Map<String, Value>) -> Result<(usize, bool), NamError> {
    let present = |key: &str| obj.get(key).filter(|v| !v.is_null());
    let legacy_size = match present("head_size") {
        None => None,
        Some(v) => Some(
            v.as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or(NamError::Invalid("head_size is not a whole number"))?,
        ),
    };
    let legacy_bias = match present("head_bias") {
        None => None,
        Some(v) => Some(
            v.as_bool()
                .ok_or(NamError::Invalid("head_bias is not a boolean"))?,
        ),
    };
    let nested = match present("head") {
        None => None,
        Some(head) => {
            let head = head
                .as_object()
                .ok_or_else(|| unsupported("head is not an object".into()))?;
            for (key, value) in head {
                if value.is_null() {
                    continue;
                }
                match key.as_str() {
                    "out_channels" | "bias" => {}
                    "kernel_size" | "dilation" if value.as_u64() == Some(1) => {}
                    other => {
                        return Err(unsupported(format!(
                            "layer head key {}",
                            other.chars().take(32).collect::<String>()
                        )));
                    }
                }
            }
            let size = head
                .get("out_channels")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or(NamError::Invalid("head out_channels is missing"))?;
            let bias = head
                .get("bias")
                .and_then(Value::as_bool)
                .ok_or(NamError::Invalid("head bias is missing"))?;
            Some((size, bias))
        }
    };
    match (nested, legacy_size, legacy_bias) {
        (Some((size, bias)), ls, lb) => {
            if ls.is_some_and(|s| s != size) || lb.is_some_and(|b| b != bias) {
                return Err(NamError::Invalid("head and head_size/head_bias disagree"));
            }
            Ok((size, bias))
        }
        (None, Some(size), Some(bias)) => Ok((size, bias)),
        (None, None, _) => Err(NamError::Invalid("head_size is missing")),
        (None, Some(_), None) => Err(NamError::Invalid("head_bias is missing")),
    }
}

/// A string, or an array of identical strings, naming "none" or "gated".
fn parse_gating_mode(value: &Value) -> Result<bool, NamError> {
    fn one(v: &Value) -> Result<bool, NamError> {
        match v.as_str() {
            Some("none") => Ok(false),
            Some("gated") => Ok(true),
            Some(other) => Err(unsupported(format!(
                "gating_mode {}",
                other.chars().take(32).collect::<String>()
            ))),
            None => Err(unsupported("gating_mode is not a string".into())),
        }
    }
    match value {
        Value::Array(items) => {
            let first = one(items
                .first()
                .ok_or(NamError::Invalid("gating_mode is empty"))?)?;
            for item in &items[1..] {
                if one(item)? != first {
                    return Err(unsupported("gating_mode differs between layers".into()));
                }
            }
            Ok(first)
        }
        v => one(v),
    }
}

fn parse_activation(value: Option<&Value>) -> Result<Activation, NamError> {
    // Current exports may write {"name": "Tanh"}; extra keys would be parameters
    // that the five supported activations do not have.
    let name = match value {
        Some(Value::Object(o)) if o.keys().all(|k| k == "name") => {
            o.get("name").and_then(Value::as_str)
        }
        other => other.and_then(Value::as_str),
    };
    match name {
        Some("Tanh") => Ok(Activation::Tanh),
        Some("Hardtanh") => Ok(Activation::Hardtanh),
        Some("Fasttanh") => Ok(Activation::Fasttanh),
        Some("ReLU") => Ok(Activation::ReLU),
        Some("Sigmoid") => Ok(Activation::Sigmoid),
        Some(other) => Err(unsupported(format!(
            "activation {}",
            other.chars().take(32).collect::<String>()
        ))),
        None => Err(unsupported("activation is not a plain name".into())),
    }
}

fn parse_lstm(config: &Map<String, Value>) -> Result<(LstmSpec, usize), NamError> {
    for (key, value) in config {
        if value.is_null() {
            continue;
        }
        match key.as_str() {
            "num_layers" | "input_size" | "hidden_size" => {}
            other => {
                return Err(unsupported(format!(
                    "unknown LSTM config key {}",
                    other.chars().take(32).collect::<String>()
                )));
            }
        }
    }
    let num_layers = req_usize(config, "num_layers", "num_layers is missing")?;
    let input_size = req_usize(config, "input_size", "input_size is missing")?;
    let hidden_size = req_usize(config, "hidden_size", "hidden_size is missing")?;
    if !(1..=MAX_LSTM_LAYERS).contains(&num_layers) {
        return Err(NamError::Invalid("LSTM num_layers out of range"));
    }
    if !(1..=MAX_LSTM_HIDDEN).contains(&hidden_size) {
        return Err(NamError::Invalid("LSTM hidden_size out of range"));
    }
    if input_size != 1 {
        return Err(NamError::Invalid("LSTM input_size is not 1"));
    }
    let h = hidden_size;
    let mut expected = 0;
    for layer in 0..num_layers {
        let input = if layer == 0 { input_size } else { h };
        expected += 4 * h * (input + h) + 4 * h + h + h; // W, bias, initial h, initial c
    }
    expected += h + 1; // head weight and bias
    Ok((
        LstmSpec {
            num_layers,
            input_size,
            hidden_size,
        },
        expected,
    ))
}
