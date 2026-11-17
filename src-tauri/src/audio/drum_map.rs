//! The standard percussion articulations by id, and the key each sounds. The same table is in `src/audio/drum-maps.json`, which
//! the TypeScript side reads; a test holds the two equal. A plan's event may name its articulation by id where the key alone does not
//! say which one it is (a rim shot and a snare hit are both key 38).

/// Every standard articulation id with the General MIDI key it sounds, in id order.
pub const SOUNDS: [(u8, u8); 94] = [
    (29, 59),
    (30, 49),
    (31, 40),
    (33, 37),
    (34, 38),
    (35, 35),
    (36, 36),
    (37, 37),
    (38, 38),
    (39, 39),
    (40, 40),
    (41, 41),
    (42, 42),
    (43, 43),
    (44, 44),
    (45, 45),
    (46, 46),
    (47, 47),
    (48, 48),
    (49, 49),
    (50, 50),
    (51, 51),
    (52, 52),
    (53, 53),
    (54, 54),
    (55, 55),
    (56, 56),
    (57, 57),
    (58, 58),
    (59, 59),
    (60, 60),
    (61, 61),
    (62, 62),
    (63, 63),
    (64, 64),
    (65, 65),
    (66, 66),
    (67, 67),
    (68, 68),
    (69, 69),
    (70, 70),
    (71, 71),
    (72, 72),
    (73, 73),
    (74, 74),
    (75, 75),
    (76, 76),
    (77, 77),
    (78, 78),
    (79, 79),
    (80, 80),
    (81, 81),
    (82, 82),
    (83, 53),
    (84, 53),
    (85, 85),
    (86, 86),
    (87, 87),
    (91, 38),
    (92, 46),
    (93, 51),
    (94, 51),
    (95, 55),
    (96, 52),
    (97, 49),
    (98, 57),
    (99, 56),
    (100, 56),
    (101, 56),
    (102, 56),
    (103, 56),
    (104, 60),
    (105, 60),
    (106, 61),
    (107, 61),
    (108, 64),
    (109, 64),
    (110, 63),
    (111, 54),
    (112, 54),
    (113, 54),
    (114, 43),
    (115, 49),
    (116, 49),
    (117, 69),
    (118, 70),
    (119, 70),
    (120, 70),
    (122, 82),
    (123, 53),
    (124, 62),
    (125, 62),
    (126, 59),
    (127, 59),
];

/// Whether `id` is a standard articulation.
pub fn is_sound(id: u8) -> bool {
    SOUNDS
        .binary_search_by_key(&id, |&(sound, _)| sound)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_equals_the_one_the_typescript_side_reads() {
        let file: serde_json::Value =
            serde_json::from_str(include_str!("../../../src/audio/drum-maps.json")).unwrap();
        let sounds: Vec<(u8, u8)> = file["sounds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row[0].as_u64().unwrap() as u8,
                    row[1].as_u64().unwrap() as u8,
                )
            })
            .collect();
        assert_eq!(sounds, SOUNDS.to_vec());
    }

    #[test]
    fn the_ids_are_ascending_and_known_ones_are_sounds() {
        assert!(SOUNDS.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert!(SOUNDS.iter().all(|&(id, key)| is_sound(id) && key < 128));
        assert!(!is_sound(0) && !is_sound(32) && !is_sound(88) && !is_sound(121) && !is_sound(255));
    }
}
