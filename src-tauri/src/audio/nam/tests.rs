use super::*;
use serde_json::{Value, json};

const WAVENET_FIXTURE: &[u8] = include_bytes!("../../../tests/fixtures/nam/wavenet.nam");
const LSTM_FIXTURE: &[u8] = include_bytes!("../../../tests/fixtures/nam/lstm.nam");
const TRAINER_STANDARD: &[u8] = include_bytes!("../../../tests/fixtures/nam/wavenet_standard.nam");
const TRAINER_MINIMAL: &[u8] = include_bytes!("../../../tests/fixtures/nam/wavenet_minimal.nam");

/// One array: channels 2, input 1, kernel 2, one layer, head 1, no head bias.
/// Weights: rechannel 2 + conv 10 + mixin 2 + layer1x1 6 + head 2 + scale 1.
const MINIMAL_WEIGHTS: usize = 23;

fn minimal() -> Value {
    json!({
        "version": "0.5.4",
        "architecture": "WaveNet",
        "config": {
            "layers": [{
                "input_size": 1, "condition_size": 1, "head_size": 1, "channels": 2,
                "kernel_size": 2, "dilations": [1], "activation": "Tanh",
                "gated": false, "head_bias": false
            }],
            "head": null,
            "head_scale": 0.02
        },
        "weights": vec![0.1; MINIMAL_WEIGHTS],
        "sample_rate": 48000
    })
}

fn layer(v: &mut Value) -> &mut Value {
    &mut v["config"]["layers"][0]
}

fn parse(v: &Value) -> Result<NamFile, NamError> {
    parse_nam(&serde_json::to_vec(v).unwrap())
}

#[test]
fn minimal_model_parses() {
    let file = parse(&minimal()).unwrap();
    assert_eq!(file.weights.len(), MINIMAL_WEIGHTS);
    assert_eq!(file.receptive_field, 2);
}

#[test]
fn parses_core_wavenet_fixture() {
    let file = parse_nam(WAVENET_FIXTURE).unwrap();
    let NamSpec::WaveNet(spec) = &file.spec else {
        panic!("expected WaveNet");
    };
    assert_eq!(spec.arrays.len(), 2);
    assert_eq!(spec.arrays[0].dilations, vec![1, 2]);
    assert_eq!(spec.arrays[1].dilations, vec![8]);
    assert_eq!(spec.arrays[0].activation, Activation::Tanh);
    assert!(!spec.arrays[0].head_bias && spec.arrays[1].head_bias);
    assert!((spec.head_scale - 0.02).abs() < 1e-9);
    assert_eq!(spec.head_scale, *file.weights.last().unwrap());
    let span: usize = spec
        .arrays
        .iter()
        .map(|a| a.dilations.iter().sum::<usize>() * (a.kernel_size - 1))
        .sum();
    assert_eq!(span, (1 + 2 + 8) * 2);
    assert_eq!(file.receptive_field - 1, span);
    assert_eq!(file.receptive_field, 23);
    // Array 1: 3 + 2 * (30 + 3 + 12) + 6 = 99. Array 2: 6 + 22 + 3 = 31. Plus head_scale.
    assert_eq!(file.weights.len(), 99 + 31 + 1);
    assert_eq!(file.model_rate, 48_000);
}

#[test]
fn parses_core_lstm_fixture() {
    let file = parse_nam(LSTM_FIXTURE).unwrap();
    assert_eq!(
        file.spec,
        NamSpec::Lstm(LstmSpec {
            num_layers: 1,
            input_size: 1,
            hidden_size: 3
        })
    );
    // 4*3*(1+3) + 12 + 3 + 3 = 66, head 3 + 1 = 4.
    assert_eq!(file.weights.len(), 70);
    assert_eq!(file.receptive_field, 0);
}

#[test]
fn legacy_gated_and_gating_mode_both_work() {
    // gated doubles conv and mixin: conv 2*2*2*2+4 = 20, mixin 4, so +10 +2 over the minimal count.
    let gated_weights = MINIMAL_WEIGHTS + 12;
    let mut legacy = minimal();
    layer(&mut legacy)["gated"] = json!(true);
    legacy["weights"] = json!(vec![0.1; gated_weights]);
    let NamSpec::WaveNet(spec) = parse(&legacy).unwrap().spec else {
        panic!()
    };
    assert!(spec.arrays[0].gated);

    let mut modern = minimal();
    let l = layer(&mut modern);
    l.as_object_mut().unwrap().remove("gated");
    l["gating_mode"] = json!(["gated"]);
    modern["weights"] = json!(vec![0.1; gated_weights]);
    assert!(parse(&modern).is_ok());
}

#[test]
fn refuses_each_cap() {
    // size
    assert_eq!(
        parse_nam(&vec![b' '; MAX_FILE_BYTES + 1]),
        Err(NamError::TooLarge)
    );

    // depth 33, with brackets inside a string ignored
    let deep = format!("{}{}", "[".repeat(33), "]".repeat(33));
    assert_eq!(parse_nam(deep.as_bytes()), Err(NamError::TooDeep));
    let ok_depth = format!(r#"{{"a":"[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[["}}"#);
    assert_eq!(
        parse_nam(ok_depth.as_bytes()),
        Err(NamError::Invalid("version is missing"))
    );

    // not JSON
    assert_eq!(parse_nam(b"{nope"), Err(NamError::NotJson));

    // 5 layer arrays
    let mut v = minimal();
    let one = v["config"]["layers"][0].clone();
    v["config"]["layers"] = json!([one, one, one, one, one]);
    assert_eq!(
        parse(&v),
        Err(NamError::Invalid("layer array count out of range"))
    );

    // 33 layers
    let mut v = minimal();
    layer(&mut v)["dilations"] = json!(vec![1; 33]);
    assert_eq!(
        parse(&v),
        Err(NamError::Invalid("layer count out of range"))
    );

    // channels 65
    let mut v = minimal();
    layer(&mut v)["channels"] = json!(65);
    assert_eq!(parse(&v), Err(NamError::Invalid("channels out of range")));

    // head_size 65
    let mut v = minimal();
    layer(&mut v)["head_size"] = json!(65);
    assert_eq!(parse(&v), Err(NamError::Invalid("head_size out of range")));

    // kernel 9
    let mut v = minimal();
    layer(&mut v)["kernel_size"] = json!(9);
    assert_eq!(
        parse(&v),
        Err(NamError::Invalid("kernel_size out of range"))
    );

    // dilation 4097 and 0
    for d in [4097, 0] {
        let mut v = minimal();
        layer(&mut v)["dilations"] = json!([d]);
        assert_eq!(parse(&v), Err(NamError::Invalid("dilation out of range")));
    }

    // ring buffers: 2 channels is fine, but 64 channels x 32 layers x 7 x 4096 is not
    let mut v = minimal();
    {
        let l = layer(&mut v);
        l["channels"] = json!(64);
        l["kernel_size"] = json!(8);
        l["dilations"] = json!(vec![4096; 32]);
    }
    v["config"]["layers"][0]["head_size"] = json!(1);
    assert_eq!(
        parse(&v),
        Err(NamError::Invalid("history buffers exceed the cap"))
    );

    // weights +1 and -1
    for count in [MINIMAL_WEIGHTS + 1, MINIMAL_WEIGHTS - 1] {
        let mut v = minimal();
        v["weights"] = json!(vec![0.1; count]);
        assert_eq!(
            parse(&v),
            Err(NamError::WeightCount {
                expected: MINIMAL_WEIGHTS,
                found: count
            })
        );
    }

    // more weights than the cap
    let mut v = minimal();
    v["weights"] = json!(vec![0; MAX_WEIGHTS + 1]);
    assert_eq!(parse(&v), Err(NamError::Invalid("too many weights")));

    // non-finite: 1e999 overflows f64, and 1e39 overflows f32
    let text = serde_json::to_string(&minimal())
        .unwrap()
        .replacen("0.1", "1e999", 1);
    assert_eq!(parse_nam(text.as_bytes()), Err(NamError::NonFinite));
    let mut v = minimal();
    v["weights"][3] = json!(1e39);
    assert_eq!(parse(&v), Err(NamError::NonFinite));
    let mut v = minimal();
    v["weights"][3] = json!("x");
    assert_eq!(
        parse(&v),
        Err(NamError::Invalid("a weight is not a number"))
    );

    // architecture and versions
    let mut v = minimal();
    v["architecture"] = json!("ConvNet");
    assert_eq!(
        parse(&v),
        Err(NamError::UnsupportedArchitecture("ConvNet".into()))
    );
    for version in ["0.4.0", "0.8.0", "1.0.0", "0.5", "x.y.z"] {
        let mut v = minimal();
        v["version"] = json!(version);
        assert_eq!(
            parse(&v),
            Err(NamError::UnsupportedVersion(version.into())),
            "{version}"
        );
    }
    for version in ["0.5.0", "0.6.0", "0.7.3"] {
        let mut v = minimal();
        v["version"] = json!(version);
        assert!(parse(&v).is_ok(), "{version}");
    }
}

#[test]
fn refuses_a2_and_unknown_features() {
    let cases: Vec<(&str, Value)> = vec![
        ("gating_mode", json!("blended")),
        ("bottleneck", json!(1)),
        ("groups_input", json!(2)),
        ("groups_input_mixin", json!(2)),
        ("layer1x1", json!({"active": false, "groups": 1})),
        ("layer1x1", json!({"active": true, "groups": 2})),
        ("head1x1", json!({"active": true})),
        ("kernel_sizes", json!([2])),
        ("activation", json!("SiLU")),
        ("film_pre", json!({})),
    ];
    for (key, value) in cases {
        let mut v = minimal();
        layer(&mut v)[key] = value.clone();
        assert!(
            matches!(parse(&v), Err(NamError::UnsupportedArchitecture(_))),
            "{key} = {value}: {:?}",
            parse(&v)
        );
    }

    let mut v = minimal();
    v["config"]["head"] = json!({"out_channels": 1});
    assert!(matches!(
        parse(&v),
        Err(NamError::UnsupportedArchitecture(_))
    ));
    let mut v = minimal();
    v["config"]["condition_dsp"] = json!({});
    assert!(matches!(
        parse(&v),
        Err(NamError::UnsupportedArchitecture(_))
    ));

    // A2 keys spelling out the defaults are accepted.
    let mut v = minimal();
    {
        let l = layer(&mut v);
        l["bottleneck"] = json!(2);
        l["groups_input"] = json!(1);
        l["groups_input_mixin"] = json!(1);
        l["layer1x1"] = json!({"active": true, "groups": 1});
        l["head1x1"] = json!({"active": false});
        l["gating_mode"] = json!("none");
    }
    assert!(parse(&v).is_ok());
}

#[test]
fn refuses_each_activation_outside_the_list() {
    for name in ["Tanh", "Hardtanh", "Fasttanh", "ReLU", "Sigmoid"] {
        let mut v = minimal();
        layer(&mut v)["activation"] = json!(name);
        assert!(parse(&v).is_ok(), "{name}");
    }
    for name in ["LeakyReLU", "PReLU", "SiLU", "Softsign", "tanh"] {
        let mut v = minimal();
        layer(&mut v)["activation"] = json!(name);
        assert!(parse(&v).is_err(), "{name}");
    }
}

#[test]
fn refuses_inconsistent_array_chains() {
    let mut v = minimal();
    layer(&mut v)["input_size"] = json!(2);
    assert!(matches!(parse(&v), Err(NamError::Invalid(_))));

    let mut v = minimal();
    layer(&mut v)["condition_size"] = json!(2);
    assert_eq!(parse(&v), Err(NamError::Invalid("condition_size is not 1")));

    let mut v = minimal();
    layer(&mut v)["head_size"] = json!(2);
    assert_eq!(
        parse(&v),
        Err(NamError::Invalid("last layer array head_size is not 1"))
    );

    // Second array must take the first one's channels and head_size.
    let mut v = minimal();
    layer(&mut v)["head_size"] = json!(2);
    let mut second = v["config"]["layers"][0].clone();
    second["input_size"] = json!(2);
    second["channels"] = json!(2);
    second["head_size"] = json!(1);
    v["config"]["layers"]
        .as_array_mut()
        .unwrap()
        .push(second.clone());
    // array1: 2 + 10 + 2 + 6 + 4 = 24; array2: 4 + 10 + 2 + 6 + 2 = 24; + 1.
    v["weights"] = json!(vec![0.1; 49]);
    assert!(parse(&v).is_ok());
    second["input_size"] = json!(1);
    v["config"]["layers"][1] = second;
    assert_eq!(
        parse(&v),
        Err(NamError::Invalid(
            "layer array input_size differs from the previous channels"
        ))
    );
}

#[test]
fn huge_dilation_refused_before_sizing() {
    let mut v = minimal();
    layer(&mut v)["dilations"] = json!([1_000_000_000]);
    assert_eq!(parse(&v), Err(NamError::Invalid("dilation out of range")));
    layer(&mut v)["dilations"] = json!([u64::MAX]);
    assert_eq!(parse(&v), Err(NamError::Invalid("dilation out of range")));
    layer(&mut v)["dilations"] = json!([-1]);
    assert_eq!(parse(&v), Err(NamError::Invalid("dilation out of range")));
}

#[test]
fn refuses_lstm_outside_caps() {
    let lstm = |layers: u64, input: u64, hidden: u64, weights: usize| {
        json!({
            "version": "0.5.4", "architecture": "LSTM",
            "config": {"num_layers": layers, "input_size": input, "hidden_size": hidden},
            "weights": vec![0.0; weights]
        })
    };
    // two layers of hidden 2: 4*2*(1+2)+8+4 = 36, then 4*2*(2+2)+8+4 = 44, head 3
    assert!(parse(&lstm(2, 1, 2, 36 + 44 + 3)).is_ok());
    assert_eq!(
        parse(&lstm(2, 1, 2, 36 + 44 + 4)),
        Err(NamError::WeightCount {
            expected: 83,
            found: 84
        })
    );
    assert!(matches!(
        parse(&lstm(5, 1, 2, 0)),
        Err(NamError::Invalid(_))
    ));
    assert!(matches!(
        parse(&lstm(1, 1, 65, 0)),
        Err(NamError::Invalid(_))
    ));
    assert!(matches!(
        parse(&lstm(1, 2, 2, 0)),
        Err(NamError::Invalid(_))
    ));
    assert!(matches!(
        parse(&lstm(0, 1, 2, 0)),
        Err(NamError::Invalid(_))
    ));
}

#[test]
fn missing_sample_rate_means_48000() {
    let mut v = minimal();
    v.as_object_mut().unwrap().remove("sample_rate");
    assert_eq!(parse(&v).unwrap().model_rate, 48_000);

    v["sample_rate"] = json!(7000);
    assert_eq!(parse(&v).unwrap().model_rate, 48_000);

    v["sample_rate"] = json!("48000");
    assert_eq!(parse(&v).unwrap().model_rate, 48_000);

    v["sample_rate"] = json!(44100);
    assert_eq!(parse(&v).unwrap().model_rate, 44_100);

    v["sample_rate"] = json!(44099.6);
    assert_eq!(parse(&v).unwrap().model_rate, 44_100);

    v["sample_rate"] = json!(1.0e9);
    assert_eq!(parse(&v).unwrap().model_rate, 48_000);
}
#[test]
fn escaped_quote_does_not_end_a_string_in_the_depth_scan() {
    // The brackets sit in a string that holds an escaped quote first.
    let text = format!(r#"{{"a":"\"{}"}}"#, "[".repeat(40));
    assert_eq!(
        parse_nam(text.as_bytes()),
        Err(NamError::Invalid("version is missing"))
    );
    // A real nesting after a closed string is still counted.
    let text = format!(r#"{{"a":"x"}}{}"#, "[".repeat(40));
    assert_eq!(parse_nam(text.as_bytes()), Err(NamError::TooDeep));
}

#[test]
fn config_needing_more_than_the_weight_cap_is_refused() {
    let array = |input: u64, channels: u64, head: u64| {
        json!({
            "input_size": input, "condition_size": 1, "head_size": head,
            "channels": channels, "kernel_size": 8, "dilations": vec![1; 32],
            "activation": "Tanh", "gated": false, "head_bias": false
        })
    };
    let v = json!({
        "version": "0.5.4", "architecture": "WaveNet",
        "config": {
            "layers": [array(1, 64, 64), array(64, 64, 64), array(64, 64, 64), array(64, 64, 1)],
            "head_scale": 0.02
        },
        "weights": [0.0]
    });
    assert_eq!(parse(&v), Err(NamError::Invalid("too many weights")));
}

#[test]
fn non_finite_head_scale_in_config_is_refused() {
    let mut v = minimal();
    v["config"]["head_scale"] = json!(1e39); // finite as f64, infinite as f32
    assert_eq!(parse(&v), Err(NamError::NonFinite));
    v["config"]["head_scale"] = json!("x");
    assert_eq!(
        parse(&v),
        Err(NamError::Invalid("head_scale is not a number"))
    );
}

#[test]
fn head_scale_comes_from_the_last_weight() {
    let mut v = minimal();
    v["config"]["head_scale"] = json!(0.5);
    v["weights"][MINIMAL_WEIGHTS - 1] = json!(0.25);
    let NamSpec::WaveNet(spec) = parse(&v).unwrap().spec else {
        panic!()
    };
    assert_eq!(spec.head_scale, 0.25);
    // Absent from the config is fine too.
    v["config"].as_object_mut().unwrap().remove("head_scale");
    assert!(parse(&v).is_ok());
}

#[test]
fn version_edge_cases() {
    let mut v = minimal();
    v["version"] = json!("0.5.4.9.9");
    assert!(matches!(parse(&v), Err(NamError::UnsupportedVersion(_))));

    v["version"] = json!(format!("0.5.{}", "9".repeat(5000)));
    let Err(NamError::UnsupportedVersion(shown)) = parse(&v) else {
        panic!()
    };
    assert!(shown.len() <= 32);

    for odd in [json!(5), json!(null), json!(["0.5.4"]), json!({"a": 1})] {
        v["version"] = odd.clone();
        assert!(
            matches!(parse(&v), Err(NamError::UnsupportedVersion(_))),
            "{odd}"
        );
    }

    v.as_object_mut().unwrap().remove("version");
    assert_eq!(parse(&v), Err(NamError::Invalid("version is missing")));
}

#[test]
fn parses_trainer_exports() {
    let file = parse_nam(TRAINER_STANDARD).unwrap();
    let NamSpec::WaveNet(spec) = &file.spec else {
        panic!("expected WaveNet");
    };
    assert_eq!(file.weights.len(), 13_802);
    assert_eq!(file.receptive_field, 4093);
    assert_eq!(spec.arrays.len(), 2);
    assert_eq!((spec.arrays[0].channels, spec.arrays[0].head_size), (16, 8));
    assert_eq!((spec.arrays[1].channels, spec.arrays[1].head_size), (8, 1));
    assert!(!spec.arrays[0].head_bias && spec.arrays[1].head_bias);
    assert_eq!(spec.arrays[0].activation, Activation::ReLU);
    assert_eq!(spec.head_scale, *file.weights.last().unwrap());

    let file = parse_nam(TRAINER_MINIMAL).unwrap();
    assert_eq!(file.weights.len(), 9);
    assert_eq!(file.receptive_field, 1);
}

#[test]
fn activation_object_form_names_a_supported_activation() {
    let mut v = minimal();
    layer(&mut v)["activation"] = json!({"name": "ReLU"});
    let NamSpec::WaveNet(spec) = parse(&v).unwrap().spec else {
        panic!()
    };
    assert_eq!(spec.arrays[0].activation, Activation::ReLU);

    for bad in [
        json!({"name": "LeakyReLU", "negative_slope": 0.01}),
        json!({"name": "Tanh", "negative_slope": 0.01}),
        json!({"name": "PReLU"}),
        json!({}),
    ] {
        layer(&mut v)["activation"] = bad.clone();
        assert!(
            matches!(parse(&v), Err(NamError::UnsupportedArchitecture(_))),
            "{bad}"
        );
    }
}

#[test]
fn nested_layer_head_maps_to_head_size_and_bias() {
    let mut v = minimal();
    {
        let l = layer(&mut v).as_object_mut().unwrap();
        l.remove("head_size");
        l.remove("head_bias");
        l.insert(
            "head".into(),
            json!({"out_channels": 1, "kernel_size": 1, "bias": true}),
        );
    }
    v["weights"] = json!(vec![0.1; MINIMAL_WEIGHTS + 1]); // head bias adds one
    let NamSpec::WaveNet(spec) = parse(&v).unwrap().spec else {
        panic!()
    };
    assert_eq!(spec.arrays[0].head_size, 1);
    assert!(spec.arrays[0].head_bias);

    // Both forms present: they must agree.
    layer(&mut v)["head_size"] = json!(1);
    layer(&mut v)["head_bias"] = json!(true);
    assert!(parse(&v).is_ok());
    layer(&mut v)["head_bias"] = json!(false);
    assert_eq!(
        parse(&v),
        Err(NamError::Invalid("head and head_size/head_bias disagree"))
    );

    // A head with a wider kernel changes the weight layout: refused.
    let mut v = minimal();
    {
        let l = layer(&mut v).as_object_mut().unwrap();
        l.remove("head_size");
        l.remove("head_bias");
        l.insert(
            "head".into(),
            json!({"out_channels": 1, "kernel_size": 3, "bias": true}),
        );
    }
    assert!(matches!(
        parse(&v),
        Err(NamError::UnsupportedArchitecture(_))
    ));
}

#[test]
fn unknown_keys_are_tolerated_only_when_null() {
    let mut v = minimal();
    v["config"]["future_thing"] = json!(null);
    layer(&mut v)["some_new_option"] = json!(null);
    layer(&mut v)["kernel_sizes"] = json!(null);
    assert!(parse(&v).is_ok());

    layer(&mut v)["some_new_option"] = json!(0);
    assert!(matches!(
        parse(&v),
        Err(NamError::UnsupportedArchitecture(_))
    ));
    layer(&mut v)["some_new_option"] = json!(null);
    v["config"]["future_thing"] = json!(1);
    assert!(matches!(
        parse(&v),
        Err(NamError::UnsupportedArchitecture(_))
    ));

    let lstm = json!({
        "version": "0.5.4", "architecture": "LSTM",
        "config": {"num_layers": 1, "input_size": 1, "hidden_size": 1, "extra": null},
        "weights": vec![0.0; 4 * 2 + 4 + 2 + 2]
    });
    assert!(parse(&lstm).is_ok());
}

#[test]
fn root_must_be_an_object_and_big_config_is_refused() {
    assert_eq!(
        parse_nam(b"[1,2]"),
        Err(NamError::Invalid("root is not an object"))
    );
    assert_eq!(parse_nam(b"{} x"), Err(NamError::NotJson));

    // 5000 nodes in config exceed the node budget without nesting deeply.
    let mut v = minimal();
    v["config"]["pad"] = json!(vec![0; 5000]);
    assert_eq!(parse(&v), Err(NamError::Invalid("config is too large")));
}

#[test]
fn metadata_and_unknown_root_keys_are_skipped() {
    let mut v = minimal();
    v["metadata"] = json!({"loudness": -20.0, "name": "x", "deep": [[1, 2], {"a": []}]});
    v["something_else"] = json!(vec![1; 10_000]);
    assert!(parse(&v).is_ok());

    // Duplicate known keys are refused rather than silently last-wins.
    let text = r#"{"version":"0.5.4","version":"0.5.4"}"#;
    assert_eq!(
        parse_nam(text.as_bytes()),
        Err(NamError::Invalid("a key appears twice"))
    );
}
