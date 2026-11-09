//! A plug-in helper's ring and the device must run at one sample rate (THE-71, review C1 of Task 13).
//!
//! A helper started at 48 kHz on a 44.1 kHz device used to trip a `debug_assert` inside `PreparedMix::prepare_with_plugins`,
//! which runs while the audio service holds its control lock, so the panic poisoned it. A mismatch is now an error that
//! leaves the track on its built-in sound, and an insert at the device's own rate is accepted at 44.1 kHz.
use std::sync::Arc;
use tabplayer_lib::{
    audio::{
        plan::PlaybackPlan,
        plugin_insert::{InsertError, InsertMode, PluginInsert},
        renderer::PreparedMix,
    },
    plugins::{
        bridge::{BridgeLink, InsertShared},
        service::InsertPlan,
        status::PluginStatus,
    },
    settings::DocumentSettings,
};
use tabplayer_plugin_protocol::{limits::pipeline_frames, ring::OwnedRing};

const CALLBACK: usize = 512;

fn plan() -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({
        "generation": 1,
        "ppq": 960,
        "durationTick": 3840,
        "durationMs": 2000,
        "tracks": [
            {"id": "t1", "program": 0, "percussion": false},
            {"id": "t2", "program": 0, "percussion": false}
        ],
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": [
            {"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 3840, "startMs": 0, "endMs": 2000}
        ],
        "notes": [],
        "midi": []
    }))
    .unwrap()
}

fn insert_plan(ring_rate: u32, latency: u32) -> InsertPlan {
    InsertPlan {
        link: BridgeLink::in_process(OwnedRing::new(ring_rate)),
        latency,
        input_db: 0.0,
        output_db: 0.0,
        shared: Arc::new(InsertShared::default()),
    }
}

#[test]
fn an_insert_on_a_48_khz_helper_at_a_44_1_khz_device_is_an_error_not_a_panic() {
    let plan = insert_plan(48_000, 0);
    let result = PluginInsert::new(
        plan.link,
        InsertMode::Realtime {
            pipeline_frames: pipeline_frames(CALLBACK),
        },
        0,
        0.0,
        0.0,
        44_100,
        plan.shared,
    );
    assert_eq!(result.err(), Some(InsertError::RateMismatch));
}

#[test]
fn an_insert_at_44_1_khz_on_a_44_1_khz_helper_is_accepted() {
    let plan = insert_plan(44_100, 64);
    let insert = PluginInsert::new(
        plan.link,
        InsertMode::Realtime {
            pipeline_frames: pipeline_frames(CALLBACK),
        },
        64,
        0.0,
        0.0,
        44_100,
        plan.shared,
    );
    assert!(insert.is_ok());
}

#[test]
fn check_agrees_with_new_on_every_refusal() {
    let realtime = InsertMode::Realtime {
        pipeline_frames: pipeline_frames(CALLBACK),
    };
    assert_eq!(
        PluginInsert::check(48_000, realtime, 0, 44_100),
        Err(InsertError::RateMismatch)
    );
    // 100 ms at 44.1 kHz is 4410 frames.
    assert_eq!(
        PluginInsert::check(44_100, realtime, 4_411, 44_100),
        Err(InsertError::TooMuchLatency)
    );
    assert_eq!(PluginInsert::check(44_100, realtime, 4_410, 44_100), Ok(()));
    assert_eq!(
        PluginInsert::check(
            44_100,
            InsertMode::Realtime { pipeline_frames: 0 },
            0,
            44_100
        ),
        Err(InsertError::PipelineTooLong)
    );
}

#[test]
fn a_mix_prepared_at_44_1_khz_with_a_48_khz_helper_plays_the_built_in_sound() {
    let plans = vec![(
        "t1".to_string(),
        Ok::<_, PluginStatus>(insert_plan(48_000, 64)),
    )];
    let mix = PreparedMix::prepare_with_plugins(
        &DocumentSettings::default(),
        &plan(),
        44_100,
        &plans,
        CALLBACK,
    )
    .expect("a rate mismatch must not fail or panic the prepare");
    assert_eq!(mix.plugin_delay_frames(), 0, "no insert was attached");
}

#[test]
fn a_mix_names_every_insert_it_refused_and_why() {
    // The runtime checks each plan before the build, but the device can change between that check and the build; the
    // mix then names what it refused, so the slot can say why instead of going quietly to the built-in sound.
    let plans = vec![
        (
            "t1".to_string(),
            Ok::<_, PluginStatus>(insert_plan(48_000, 64)),
        ),
        (
            "t2".to_string(),
            Ok::<_, PluginStatus>(insert_plan(44_100, 4_411)),
        ),
    ];
    let mix = PreparedMix::prepare_with_plugins(
        &DocumentSettings::default(),
        &plan(),
        44_100,
        &plans,
        CALLBACK,
    )
    .unwrap();
    assert_eq!(
        mix.plugin_refusals(),
        &[
            ("t1".to_string(), InsertError::RateMismatch),
            ("t2".to_string(), InsertError::TooMuchLatency),
        ]
    );
    let accepted = PreparedMix::prepare_with_plugins(
        &DocumentSettings::default(),
        &plan(),
        44_100,
        &[(
            "t1".to_string(),
            Ok::<_, PluginStatus>(insert_plan(44_100, 64)),
        )],
        CALLBACK,
    )
    .unwrap();
    assert!(accepted.plugin_refusals().is_empty());
}

#[test]
fn a_mix_prepared_at_44_1_khz_with_a_44_1_khz_helper_attaches_the_insert() {
    let plans = vec![(
        "t1".to_string(),
        Ok::<_, PluginStatus>(insert_plan(44_100, 64)),
    )];
    let mix = PreparedMix::prepare_with_plugins(
        &DocumentSettings::default(),
        &plan(),
        44_100,
        &plans,
        CALLBACK,
    )
    .unwrap();
    assert_eq!(mix.plugin_delay_frames(), 64 + pipeline_frames(CALLBACK));
}
