//! Small string helpers shared across the backend.

/// The longest prefix of `s` at most `max_bytes` long that ends on a UTF-8
/// character boundary. Slicing `&s[..n]` directly panics when `n` falls inside
/// a multi-byte character (Arabic, CJK, emoji), so every byte-capped cut goes
/// through here.
pub fn truncate_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_back_to_the_previous_character() {
        assert_eq!(truncate_bytes("hello", 10), "hello");
        assert_eq!(truncate_bytes("hello", 3), "hel");
        // "ا" is two bytes: a cut after its first byte backs off before it.
        assert_eq!(truncate_bytes("aا", 2), "a");
        assert_eq!(truncate_bytes("😀", 3), "");
    }
}
