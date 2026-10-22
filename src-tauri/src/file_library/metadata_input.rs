//! Read-only, bounded index input. This deliberately does not validate music or assets.
use super::types::{MetadataBase, MetadataEdit, MetadataInput};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, BufRead, BufReader, Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

const SCORE_LIMIT: usize = 64 * 1024 * 1024;
const PROJECT_LIMIT: usize = 512 * 1024 * 1024;
const EDIT_LIMIT: usize = 2 * 1024 * 1024;
const BASE64_LIMIT: usize = SCORE_LIMIT.div_ceil(3) * 4;
const CHUNK_SIZE: usize = 64 * 1024;
const EDIT_LIMIT_ERROR: &str = "Indexed metadata operations exceed the 2 MiB limit.";

pub struct MetadataInputReader;

impl MetadataInputReader {
    pub fn read(path: &Path) -> Result<MetadataInput, String> {
        Self::read_with_cancel(path, &AtomicBool::new(false))
    }

    pub(crate) fn read_with_cancel(
        path: &Path,
        cancelled: &AtomicBool,
    ) -> Result<MetadataInput, String> {
        let suffix = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let native = suffix == "tabplayer";
        if !native
            && !matches!(
                suffix.as_str(),
                "gp" | "gpx" | "gp3" | "gp4" | "gp5" | "xml" | "musicxml" | "mxl"
            )
        {
            return Err("This file type is not supported by the score index.".into());
        }
        let file = File::open(path).map_err(|error| format!("Cannot read score: {error}"))?;
        Self::read_file(&file, &file, cancelled, native)
    }

    fn read_file<R: Read>(
        file: &File,
        input: R,
        cancelled: &AtomicBool,
        native: bool,
    ) -> Result<MetadataInput, String> {
        let before = file
            .metadata()
            .map_err(|error| format!("Cannot inspect score: {error}"))?;
        let limit = if native { PROJECT_LIMIT } else { SCORE_LIMIT };
        if !before.is_file() || before.len() > limit as u64 {
            return Err(format!(
                "Indexed score must be a regular file of at most {} MiB.",
                limit / (1024 * 1024)
            ));
        }
        let mut source = HashingRead {
            input,
            cancelled,
            limit,
            length: 0,
            hash: Sha256::new(),
        };
        let (base, edits) = if native {
            let mut json = Json::new(&mut source);
            let projection = json.project()?;
            json.whitespace()?;
            if json.peek()?.is_some() {
                return Err("Unexpected data after the indexed project.".into());
            }
            projection
        } else {
            let mut bytes = Vec::with_capacity(before.len() as usize);
            let mut chunk = [0; CHUNK_SIZE];
            loop {
                let count = source.read(&mut chunk).map_err(|error| error.to_string())?;
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
            }
            (
                MetadataBase::File {
                    bytes_base64: STANDARD.encode(bytes),
                },
                Vec::new(),
            )
        };
        let after = file
            .metadata()
            .map_err(|error| format!("Cannot recheck indexed score: {error}"))?;
        if before.len() != after.len()
            || before.modified().ok() != after.modified().ok()
            || source.length as u64 != before.len()
        {
            return Err("The score changed while its metadata was being read.".into());
        }
        if cancelled.load(Ordering::Acquire) {
            return Err("Metadata read was cancelled.".into());
        }
        Ok(MetadataInput {
            sha256: format!("{:x}", source.hash.finalize()),
            base,
            edits,
        })
    }
}

struct HashingRead<'a, R> {
    input: R,
    cancelled: &'a AtomicBool,
    limit: usize,
    length: usize,
    hash: Sha256,
}

impl<R: Read> Read for HashingRead<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(io::Error::other("Metadata read was cancelled."));
        }
        let maximum = buffer
            .len()
            .min(CHUNK_SIZE)
            .min(self.limit.saturating_sub(self.length) + 1);
        let count = self.input.read(&mut buffer[..maximum])?;
        self.length += count;
        if self.length > self.limit {
            return Err(io::Error::other(
                "Indexed score exceeds its input size limit.",
            ));
        }
        self.hash.update(&buffer[..count]);
        Ok(count)
    }
}

// Strings are decoded incrementally. Ignored strings never enter an allocation;
// retained candidates stop growing at their bound, even when `type` appears last.
struct Json<R> {
    input: BufReader<R>,
}

impl<R: Read> Json<R> {
    fn new(input: R) -> Self {
        Self {
            input: BufReader::with_capacity(CHUNK_SIZE, input),
        }
    }

    fn peek(&mut self) -> Result<Option<u8>, String> {
        Ok(self
            .input
            .fill_buf()
            .map_err(|error| error.to_string())?
            .first()
            .copied())
    }

    fn byte(&mut self) -> Result<u8, String> {
        let value = self.peek()?.ok_or("Indexed project JSON is truncated.")?;
        self.input.consume(1);
        Ok(value)
    }

    fn whitespace(&mut self) -> Result<(), String> {
        while self
            .peek()?
            .is_some_and(|value| matches!(value, b' ' | b'\n' | b'\r' | b'\t'))
        {
            self.input.consume(1);
        }
        Ok(())
    }

    fn expect(&mut self, expected: u8) -> Result<(), String> {
        self.whitespace()?;
        if self.byte()? != expected {
            return Err("Indexed project contains malformed JSON.".into());
        }
        Ok(())
    }

    fn unicode(&mut self) -> Result<u32, String> {
        let mut value = 0;
        for _ in 0..4 {
            value = (value << 4)
                | (self.byte()? as char)
                    .to_digit(16)
                    .ok_or("Invalid JSON Unicode escape.")?;
        }
        Ok(value)
    }

    fn string(&mut self, limit: Option<usize>) -> Result<Option<String>, String> {
        self.expect(b'"')?;
        let mut retained = limit.map(|_| String::new());
        loop {
            let byte = self.byte()?;
            let character = match byte {
                b'"' => return Ok(retained),
                0..=31 => return Err("JSON strings cannot contain control characters.".into()),
                b'\\' => match self.byte()? {
                    b'"' => '"',
                    b'\\' => '\\',
                    b'/' => '/',
                    b'b' => '\u{0008}',
                    b'f' => '\u{000c}',
                    b'n' => '\n',
                    b'r' => '\r',
                    b't' => '\t',
                    b'u' => {
                        let mut code = self.unicode()?;
                        if (0xd800..=0xdbff).contains(&code) {
                            if self.byte()? != b'\\' || self.byte()? != b'u' {
                                return Err("Invalid JSON Unicode surrogate pair.".into());
                            }
                            let low = self.unicode()?;
                            if !(0xdc00..=0xdfff).contains(&low) {
                                return Err("Invalid JSON Unicode surrogate pair.".into());
                            }
                            code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
                        }
                        char::from_u32(code).ok_or("Invalid JSON Unicode character.")?
                    }
                    _ => return Err("Invalid JSON string escape.".into()),
                },
                32..=127 => byte as char,
                _ => {
                    let length = match byte {
                        0xc2..=0xdf => 2,
                        0xe0..=0xef => 3,
                        0xf0..=0xf4 => 4,
                        _ => return Err("Invalid UTF-8 in indexed project.".into()),
                    };
                    let mut bytes = [byte; 4];
                    for item in bytes.iter_mut().take(length).skip(1) {
                        *item = self.byte()?;
                    }
                    std::str::from_utf8(&bytes[..length])
                        .map_err(|_| "Invalid UTF-8 in indexed project.")?
                        .chars()
                        .next()
                        .unwrap()
                }
            };
            if let Some(value) = &mut retained {
                if value.len() + character.len_utf8() > limit.unwrap() {
                    retained = None;
                } else {
                    value.push(character);
                }
            }
        }
    }

    fn text(&mut self, limit: usize) -> Result<String, String> {
        self.string(Some(limit))?
            .ok_or_else(|| "Indexed metadata text exceeds its size limit.".into())
    }

    fn number(&mut self) -> Result<serde_json::Number, String> {
        self.whitespace()?;
        let mut token = Vec::new();
        while self.peek()?.is_some_and(|value| {
            !matches!(value, b' ' | b'\n' | b'\r' | b'\t' | b',' | b']' | b'}')
        }) {
            if token.len() == 128 {
                return Err("Indexed project has an oversized JSON number.".into());
            }
            token.push(self.byte()?);
        }
        serde_json::from_slice(&token).map_err(|_| "Invalid JSON number in indexed project.".into())
    }

    fn unsigned(&mut self) -> Result<u32, String> {
        self.number()?
            .as_u64()
            .and_then(|number| number.try_into().ok())
            .ok_or_else(|| "Indexed project expected an unsigned integer.".into())
    }

    fn object(
        &mut self,
        mut visit: impl FnMut(&mut Self, Option<String>) -> Result<(), String>,
    ) -> Result<(), String> {
        self.expect(b'{')?;
        self.whitespace()?;
        if self.peek()? == Some(b'}') {
            self.byte()?;
            return Ok(());
        }
        loop {
            let key = self.string(Some(128))?;
            self.expect(b':')?;
            visit(self, key)?;
            self.whitespace()?;
            match self.byte()? {
                b'}' => return Ok(()),
                b',' => {}
                _ => return Err("Indexed project contains malformed JSON object.".into()),
            }
        }
    }

    fn array(
        &mut self,
        mut visit: impl FnMut(&mut Self) -> Result<(), String>,
    ) -> Result<(), String> {
        self.expect(b'[')?;
        self.whitespace()?;
        if self.peek()? == Some(b']') {
            self.byte()?;
            return Ok(());
        }
        loop {
            visit(self)?;
            self.whitespace()?;
            match self.byte()? {
                b']' => return Ok(()),
                b',' => {}
                _ => return Err("Indexed project contains malformed JSON array.".into()),
            }
        }
    }

    fn skip(&mut self, depth: usize) -> Result<(), String> {
        if depth > 128 {
            return Err("Indexed project JSON exceeds the nesting limit.".into());
        }
        self.whitespace()?;
        match self.peek()? {
            Some(b'"') => self.string(None).map(|_| ()),
            Some(b'{') => self.object(|json, _| json.skip(depth + 1)),
            Some(b'[') => self.array(|json| json.skip(depth + 1)),
            Some(b't' | b'f' | b'n') => {
                let literal: &[u8] = match self.peek()? {
                    Some(b't') => b"true",
                    Some(b'f') => b"false",
                    _ => b"null",
                };
                for expected in literal {
                    if self.byte()? != *expected {
                        return Err("Invalid JSON literal in indexed project.".into());
                    }
                }
                Ok(())
            }
            Some(b'-' | b'0'..=b'9') => self.number().map(|_| ()),
            _ => Err("Invalid JSON value in indexed project.".into()),
        }
    }

    fn project(&mut self) -> Result<(MetadataBase, Vec<MetadataEdit>), String> {
        let mut fields = 0;
        let mut version = 0;
        let mut base = None;
        let mut baseline = Vec::new();
        let mut applied = Vec::new();
        let mut budget = 2; // JSON array brackets; commas are charged below.
        self.object(|json, key| {
            let index = match key.as_deref() {
                Some("format") => 0,
                Some("schemaVersion") => 1,
                Some("engineVersion") => 2,
                Some("base") => 3,
                Some("edits") => 4,
                Some("assets") => 5,
                Some("baselineEdits") => 6,
                _ => return Err("Indexed project contains an unknown field.".into()),
            };
            seen(&mut fields, index)?;
            match index {
                0 if json.text(128)? != "TabPlayer" => {
                    return Err("This is not a TabPlayer project.".into());
                }
                0 => {}
                1 => version = json.unsigned()?,
                2 => {
                    json.string(None)?;
                }
                3 => base = Some(json.base()?),
                4 => applied = json.edits(&mut budget)?,
                5 => json.object(|json, _| json.skip(1))?,
                6 => baseline = json.edits(&mut budget)?,
                _ => unreachable!(),
            }
            Ok(())
        })?;
        let expected = match version {
            1 => 0b0011111,
            2 => 0b0111111,
            3 => 0b1111111,
            _ => return Err("This is not a supported TabPlayer project version.".into()),
        };
        if fields != expected {
            return Err("Indexed project has missing or incompatible schema fields.".into());
        }
        baseline.extend(applied);
        Ok((base.unwrap(), baseline))
    }

    fn base(&mut self) -> Result<MetadataBase, String> {
        let mut fields = 0;
        let mut kind = String::new();
        let mut title = None;
        let mut artist = None;
        let mut bytes = None;
        let mut digest = None;
        self.object(|json, key| {
            let index = match key.as_deref() {
                Some("kind") => 0,
                Some("title") => 1,
                Some("artist") => 2,
                Some("tempo") => 3,
                Some("tuning") => 4,
                Some("measureCount") => 5,
                Some("filename") => 6,
                Some("bytesBase64") => 7,
                Some("sha256") => 8,
                _ => return Err("Indexed project base contains an unknown field.".into()),
            };
            seen(&mut fields, index)?;
            match index {
                0 => kind = json.text(128)?,
                1 => title = Some(json.text(EDIT_LIMIT)?),
                2 => artist = Some(json.text(EDIT_LIMIT)?),
                3 => {
                    json.number()?;
                }
                4 => json.array(|json| {
                    json.number()?
                        .as_i64()
                        .and_then(|value| i32::try_from(value).ok())
                        .ok_or("Indexed tuning expected an integer.")?;
                    Ok(())
                })?,
                5 => {
                    json.unsigned()?;
                }
                6 => {
                    json.string(None)?;
                }
                7 => {
                    bytes = Some(
                        json.string(Some(BASE64_LIMIT))?
                            .ok_or("Embedded original score exceeds the 64 MiB limit.")?,
                    )
                }
                8 => digest = Some(json.text(128)?),
                _ => unreachable!(),
            }
            Ok(())
        })?;
        match (kind.as_str(), fields) {
            ("blank", 0b000111111) => Ok(MetadataBase::Blank {
                title: title.unwrap(),
                artist: artist.unwrap(),
            }),
            ("file", 0b111000001) => {
                let bytes_base64 = bytes.unwrap();
                let decoded = STANDARD
                    .decode(bytes_base64.as_bytes())
                    .map_err(|_| "Original score bytes are corrupt.")?;
                if decoded.len() > SCORE_LIMIT {
                    return Err("Embedded original score exceeds the 64 MiB limit.".into());
                }
                if !format!("{:x}", Sha256::digest(&decoded)).eq_ignore_ascii_case(&digest.unwrap())
                {
                    return Err("Original score checksum does not match.".into());
                }
                Ok(MetadataBase::File { bytes_base64 })
            }
            _ => Err("Indexed project has an unsupported or incomplete base.".into()),
        }
    }

    /// A non-negative integer index, or `None` for any other value (refused as missing later).
    fn index(&mut self) -> Result<Option<u32>, String> {
        self.whitespace()?;
        if matches!(self.peek()?, Some(b'0'..=b'9' | b'-')) {
            Ok(self
                .number()?
                .as_u64()
                .and_then(|value| value.try_into().ok()))
        } else {
            self.skip(0)?;
            Ok(None)
        }
    }

    fn candidate_text(&mut self) -> Result<Option<String>, String> {
        self.whitespace()?;
        if self.peek()? == Some(b'"') {
            self.string(Some(EDIT_LIMIT))
        } else {
            self.skip(0)?;
            Ok(None)
        }
    }

    fn album(&mut self) -> Result<Option<String>, String> {
        self.whitespace()?;
        if self.peek()? != Some(b'{') {
            self.skip(0)?;
            return Ok(None);
        }
        let mut album = None;
        let mut found = false;
        let mut duplicate = false;
        self.object(|json, key| {
            if key.as_deref() == Some("album") {
                duplicate |= found;
                found = true;
                album = json.candidate_text()?;
                Ok(())
            } else {
                json.skip(0)
            }
        })?;
        Ok(if duplicate { None } else { album })
    }

    fn edits(&mut self, budget: &mut usize) -> Result<Vec<MetadataEdit>, String> {
        let mut edits = Vec::new();
        self.array(|json| {
            if let Some(edit) = json.edit()? {
                let mut count = Count(*budget);
                serde_json::to_writer(&mut count, &edit).map_err(|_| EDIT_LIMIT_ERROR)?;
                // Charging one comma per edit is corrected for the first below.
                *budget = count.0 + usize::from(*budget > 2);
                if *budget > EDIT_LIMIT {
                    return Err(EDIT_LIMIT_ERROR.into());
                }
                edits.push(edit);
            }
            Ok(())
        })?;
        Ok(edits)
    }

    fn edit(&mut self) -> Result<Option<MetadataEdit>, String> {
        let mut fields = 0;
        let mut duplicates = 0;
        let mut kind = None;
        let mut title = None;
        let mut artist = None;
        let mut name = None;
        let mut track = None;
        let mut album = None;
        let mut to = None;
        self.object(|json, key| {
            if key.as_deref() == Some("type") {
                seen(&mut fields, 0)?;
                kind = Some(json.string(Some(128))?.unwrap_or_default());
                return Ok(());
            }
            if kind.as_deref().is_some_and(|kind| !relevant(kind)) {
                return json.skip(0);
            }
            let index = match key.as_deref() {
                Some("title") => Some(1),
                Some("artist") => Some(2),
                Some("name") => Some(3),
                Some("track") => Some(4),
                Some("fields") => Some(5),
                Some("to") => Some(6),
                _ => None,
            };
            if let Some(index) = index {
                if seen(&mut fields, index).is_err() {
                    duplicates |= 1 << index;
                }
            }
            match key.as_deref() {
                Some("title") => {
                    title = json.candidate_text()?;
                }
                Some("artist") => {
                    artist = json.candidate_text()?;
                }
                Some("name") => {
                    name = json.candidate_text()?;
                }
                Some("track") => {
                    track = json.index()?;
                }
                Some("to") => {
                    to = json.index()?;
                }
                Some("fields") => {
                    album = json.album()?;
                }
                _ => json.skip(0)?,
            }
            Ok(())
        })?;
        let missing = || {
            "Indexed metadata operation has missing, invalid or oversized fields (2 MiB limit)."
                .to_string()
        };
        let relevant_fields = match kind.as_deref() {
            Some("setScoreInfo") => (1 << 1) | (1 << 2),
            Some("setScoreMetadata") => 1 << 5,
            Some("setTrackInfo") => (1 << 3) | (1 << 4),
            Some("addTrack" | "addPitchedTrack" | "addPercussionTrack") => 1 << 3,
            Some("removeTrack") => 1 << 4,
            Some("moveTrack") => (1 << 4) | (1 << 6),
            _ => 0,
        };
        if duplicates & relevant_fields != 0 {
            return Err("Indexed metadata operation contains a duplicate field.".into());
        }
        Ok(
            match kind
                .as_deref()
                .ok_or("Indexed edit needs a string type field.")?
            {
                "setScoreInfo" => Some(MetadataEdit::SetScoreInfo {
                    title: title.ok_or_else(missing)?,
                    artist: artist.ok_or_else(missing)?,
                }),
                "setScoreMetadata" => Some(MetadataEdit::SetScoreMetadata {
                    album: album.ok_or_else(missing)?,
                }),
                "setTrackInfo" => Some(MetadataEdit::SetTrackInfo {
                    track: track.ok_or_else(missing)?,
                    name: name.ok_or_else(missing)?,
                }),
                "addTrack" => Some(MetadataEdit::AddTrack {
                    name: name.ok_or_else(missing)?,
                }),
                "addPitchedTrack" => Some(MetadataEdit::AddPitchedTrack {
                    name: name.ok_or_else(missing)?,
                }),
                "addPercussionTrack" => Some(MetadataEdit::AddPercussionTrack {
                    name: name.ok_or_else(missing)?,
                }),
                "removeTrack" => Some(MetadataEdit::RemoveTrack {
                    track: track.ok_or_else(missing)?,
                }),
                "moveTrack" => Some(MetadataEdit::MoveTrack {
                    track: track.ok_or_else(missing)?,
                    to: to.ok_or_else(missing)?,
                }),
                _ => None,
            },
        )
    }
}

fn relevant(kind: &str) -> bool {
    matches!(
        kind,
        "setScoreInfo"
            | "setScoreMetadata"
            | "setTrackInfo"
            | "addTrack"
            | "addPitchedTrack"
            | "addPercussionTrack"
            | "removeTrack"
            | "moveTrack"
    )
}

fn seen(fields: &mut u32, index: u32) -> Result<(), String> {
    let bit = 1 << index;
    if *fields & bit != 0 {
        return Err("Indexed project contains a duplicate field.".into());
    }
    *fields |= bit;
    Ok(())
}

struct Count(usize);

impl Write for Count {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0 += buffer.len();
        if self.0 > EDIT_LIMIT {
            return Err(io::Error::other(EDIT_LIMIT_ERROR));
        }
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, OpenOptions};

    struct DuringRead<'a, F> {
        input: &'a File,
        change: Option<F>,
    }

    impl<F: FnOnce()> Read for DuringRead<'_, F> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let count = self.input.read(buffer)?;
            if let Some(change) = self.change.take() {
                change();
            }
            Ok(count)
        }
    }

    #[test]
    fn read_detects_a_file_changed_between_actual_read_chunks() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("score.gp");
        fs::write(&path, vec![0; CHUNK_SIZE * 2]).unwrap();
        let file = File::open(&path).unwrap();
        let changed = OpenOptions::new().write(true).open(&path).unwrap();
        let input = DuringRead {
            input: &file,
            change: Some(|| changed.set_len((CHUNK_SIZE * 3) as u64).unwrap()),
        };
        let error = MetadataInputReader::read_file(&file, input, &AtomicBool::new(false), false)
            .unwrap_err();
        assert!(error.contains("changed"), "{error}");
    }

    #[test]
    fn read_checks_cooperative_cancellation_between_actual_read_chunks() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("score.gp");
        fs::write(&path, vec![0; CHUNK_SIZE * 2]).unwrap();
        let file = File::open(&path).unwrap();
        let cancelled = AtomicBool::new(false);
        let input = DuringRead {
            input: &file,
            change: Some(|| cancelled.store(true, Ordering::Release)),
        };
        let error = MetadataInputReader::read_file(&file, input, &cancelled, false).unwrap_err();
        assert!(error.contains("cancelled"), "{error}");
    }
}
