//! Streaming reader for the root of a `.nam` file.
//!
//! The file is untrusted, so nothing is built as a generic JSON tree except a
//! small, node-bounded `config`. `weights` are pushed into a `Vec<f32>` one at
//! a time and stop at the cap; unknown root keys (such as `metadata`) are
//! skipped without being collected.

use super::file::{MAX_WEIGHTS, NamError};
use serde::Deserialize;
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use serde_json::value::RawValue;
use std::cell::{Cell, RefCell};
use std::fmt;

/// Largest number of JSON nodes (values, arrays, objects) kept from `config`.
pub(super) const MAX_CONFIG_NODES: usize = 4096;

/// A small value: a string or number is kept, anything else is skipped.
pub(super) enum Scalar {
    Str(String),
    Num(f64),
    Other,
}

struct ScalarVisitor;

impl<'de> Visitor<'de> for ScalarVisitor {
    type Value = Scalar;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_str<E>(self, v: &str) -> Result<Scalar, E> {
        Ok(Scalar::Str(v.to_owned()))
    }
    fn visit_f64<E>(self, v: f64) -> Result<Scalar, E> {
        Ok(Scalar::Num(v))
    }
    fn visit_u64<E>(self, v: u64) -> Result<Scalar, E> {
        Ok(Scalar::Num(v as f64))
    }
    fn visit_i64<E>(self, v: i64) -> Result<Scalar, E> {
        Ok(Scalar::Num(v as f64))
    }
    fn visit_bool<E>(self, _: bool) -> Result<Scalar, E> {
        Ok(Scalar::Other)
    }
    fn visit_unit<E>(self) -> Result<Scalar, E> {
        Ok(Scalar::Other)
    }
    fn visit_none<E>(self) -> Result<Scalar, E> {
        Ok(Scalar::Other)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Scalar, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Scalar::Other)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Scalar, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(Scalar::Other)
    }
}

impl<'de> Deserialize<'de> for Scalar {
    fn deserialize<D: de::Deserializer<'de>>(d: D) -> Result<Scalar, D::Error> {
        d.deserialize_any(ScalarVisitor)
    }
}

#[derive(Default)]
pub(super) struct RawNam {
    pub version: Option<Scalar>,
    pub architecture: Option<Scalar>,
    pub sample_rate: Option<Scalar>,
    pub config: Option<Value>,
    pub weights: Option<Vec<f32>>,
}

/// Carries the specific refusal out of serde's error type.
struct Ctx {
    refusal: RefCell<Option<NamError>>,
}

impl Ctx {
    fn fail<E: de::Error>(&self, why: NamError) -> E {
        self.refusal.borrow_mut().get_or_insert(why);
        E::custom("refused")
    }
}

pub(super) fn read_root(bytes: &[u8]) -> Result<RawNam, NamError> {
    if bytes.iter().find(|b| !b.is_ascii_whitespace()) != Some(&b'{') {
        return Err(NamError::Invalid("root is not an object"));
    }
    let ctx = Ctx {
        refusal: RefCell::new(None),
    };
    let mut de = serde_json::Deserializer::from_slice(bytes);
    let result = RootSeed(&ctx)
        .deserialize(&mut de)
        .and_then(|raw| de.end().map(|_| raw));
    result.map_err(|_| ctx.refusal.into_inner().unwrap_or(NamError::NotJson))
}

struct RootSeed<'a>(&'a Ctx);

impl<'de, 'a> DeserializeSeed<'de> for RootSeed<'a> {
    type Value = RawNam;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<RawNam, D::Error> {
        d.deserialize_map(RootVisitor(self.0))
    }
}

struct RootVisitor<'a>(&'a Ctx);

impl<'de, 'a> Visitor<'de> for RootVisitor<'a> {
    type Value = RawNam;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a NAM file object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<RawNam, A::Error> {
        let ctx = self.0;
        let budget = Cell::new(MAX_CONFIG_NODES);
        let mut raw = RawNam::default();
        while let Some(key) = map.next_key::<String>()? {
            let duplicate = match key.as_str() {
                "version" => raw.version.replace(map.next_value()?).is_some(),
                "architecture" => raw.architecture.replace(map.next_value()?).is_some(),
                "sample_rate" => raw.sample_rate.replace(map.next_value()?).is_some(),
                "config" => raw
                    .config
                    .replace(map.next_value_seed(BoundedValue {
                        budget: &budget,
                        ctx,
                    })?)
                    .is_some(),
                "weights" => raw
                    .weights
                    .replace(map.next_value_seed(WeightsSeed(ctx))?)
                    .is_some(),
                _ => {
                    map.next_value::<IgnoredAny>()?;
                    false
                }
            };
            if duplicate {
                return Err(ctx.fail(NamError::Invalid("a key appears twice")));
            }
        }
        Ok(raw)
    }
}

struct WeightsSeed<'a>(&'a Ctx);

impl<'de, 'a> DeserializeSeed<'de> for WeightsSeed<'a> {
    type Value = Vec<f32>;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<Vec<f32>, D::Error> {
        d.deserialize_any(WeightsVisitor(self.0))
    }
}

struct WeightsVisitor<'a>(&'a Ctx);

impl<'de, 'a> Visitor<'de> for WeightsVisitor<'a> {
    type Value = Vec<f32>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an array of numbers")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<f32>, A::Error> {
        let ctx = self.0;
        let mut weights = Vec::new();
        // The raw token is read, not parsed by serde_json, which would refuse
        // an out-of-range number such as 1e999 as a syntax error. Rust's parser
        // returns infinity for it, which is reported as NonFinite below.
        while let Some(raw) = seq.next_element::<&'de RawValue>()? {
            if weights.len() >= MAX_WEIGHTS {
                return Err(ctx.fail(NamError::Invalid("too many weights")));
            }
            let Ok(x) = raw.get().parse::<f64>() else {
                return Err(ctx.fail(NamError::Invalid("a weight is not a number")));
            };
            let x = x as f32;
            if !x.is_finite() {
                return Err(ctx.fail(NamError::NonFinite));
            }
            weights.push(x);
        }
        Ok(weights)
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<Vec<f32>, E> {
        Err(self.0.fail(NamError::Invalid("weights is not an array")))
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Vec<f32>, E> {
        Err(self.0.fail(NamError::Invalid("weights is not an array")))
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Vec<f32>, E> {
        Err(self.0.fail(NamError::Invalid("weights is not an array")))
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Vec<f32>, E> {
        Err(self.0.fail(NamError::Invalid("weights is not an array")))
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Vec<f32>, E> {
        Err(self.0.fail(NamError::Invalid("weights is not an array")))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Vec<f32>, E> {
        Err(self.0.fail(NamError::Invalid("weights is not an array")))
    }
    fn visit_map<A: MapAccess<'de>>(self, _: A) -> Result<Vec<f32>, A::Error> {
        Err(self.0.fail(NamError::Invalid("weights is not an array")))
    }
}

/// A `serde_json::Value` that gives up after `MAX_CONFIG_NODES` nodes.
struct BoundedValue<'a> {
    budget: &'a Cell<usize>,
    ctx: &'a Ctx,
}

impl<'a> BoundedValue<'a> {
    fn spend<E: de::Error>(&self) -> Result<(), E> {
        match self.budget.get() {
            0 => Err(self.ctx.fail(NamError::Invalid("config is too large"))),
            n => {
                self.budget.set(n - 1);
                Ok(())
            }
        }
    }
    fn child(&self) -> BoundedValue<'a> {
        BoundedValue {
            budget: self.budget,
            ctx: self.ctx,
        }
    }
}

impl<'de, 'a> DeserializeSeed<'de> for BoundedValue<'a> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de, 'a> Visitor<'de> for BoundedValue<'a> {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        self.spend()?;
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        self.spend()?;
        Ok(Value::from(v))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        self.spend()?;
        Ok(Value::from(v))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        self.spend()?;
        Ok(Value::from(v))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        self.spend()?;
        Ok(Value::String(v.to_owned()))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        self.spend()?;
        Ok(Value::Null)
    }
    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        self.spend()?;
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        self.spend()?;
        let mut items = Vec::new();
        while let Some(item) = seq.next_element_seed(self.child())? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        self.spend()?;
        let mut out = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            let value = map.next_value_seed(self.child())?;
            out.insert(key, value);
        }
        Ok(Value::Object(out))
    }
}
