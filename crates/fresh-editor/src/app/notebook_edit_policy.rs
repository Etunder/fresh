//! Protect notebook serialization while ordinary editor actions edit cell source.
//! Plugin cell commands use their own direct buffer operations; history replay remains
//! unrestricted so inserting/deleting/reordering cells can still be undone.
use fresh_editor_core::model::event::Event;
use std::ops::Range;

fn source_ranges(text: &str) -> Vec<Range<usize>> {
    let mut markers = Vec::new();
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if line.starts_with("# %%") {
            markers.push((
                offset,
                offset + line.len(),
                line.contains("[markdown]") || line.contains("[raw]"),
            ));
        }
        offset += line.len();
    }
    let mut ranges = Vec::new();
    for (i, &(_, start, markdown)) in markers.iter().enumerate() {
        let next = markers.get(i + 1).map(|m| m.0).unwrap_or(text.len());
        let mut end = next;
        // The serialization newline and inter-cell spacer aren't source text.
        if end > start && text.as_bytes()[end - 1] == b'\n' {
            end -= 1;
        }
        if i + 1 < markers.len() && end > start && text.as_bytes()[end - 1] == b'\n' {
            end -= 1;
        }
        let end = end.max(start);
        let body = &text[start..end];
        if markdown
            && (body.starts_with("r\"\"\"\n")
                || body.starts_with("R\"\"\"\n")
                || body.starts_with("\"\"\"\n"))
            && body.ends_with("\"\"\"")
        {
            let opening = body.find('\n').unwrap() + 1;
            ranges.push(start + opening..end - 3);
        } else if markdown {
            let mut at = start;
            for line in body.split('\n') {
                let prefix = if line.starts_with("# ") {
                    2
                } else if line.starts_with('#') {
                    1
                } else {
                    0
                };
                ranges.push(at + prefix..at + line.len());
                at += line.len() + 1;
            }
        } else {
            ranges.push(start..end);
        }
    }
    ranges
}

pub(super) fn edits_allowed(text: &str, events: &[Event]) -> bool {
    let ranges = source_ranges(text);
    for event in events {
        let (start, end, inserted) = match event {
            Event::Insert { position, text, .. } => (*position, *position, text.as_str()),
            Event::Delete { range, .. } => (range.start, range.end, ""),
            Event::Batch { events, .. } => {
                if !edits_allowed(text, events) {
                    return false;
                }
                continue;
            }
            _ => continue,
        };
        if !ranges
            .iter()
            .any(|r| r.start <= start && start <= end && end <= r.end)
        {
            return false;
        }
        if !text.is_char_boundary(start) || !text.is_char_boundary(end) {
            return false;
        }
        // Reject reserved percent markers and raw-string delimiters, including ones
        // assembled by typing a character at a time or by joining existing lines.
        let Some(source) = ranges.iter().find(|r| r.start <= start && end <= r.end) else {
            return false;
        };
        let mut after = text[source.clone()].to_string();
        after.replace_range(start - source.start..end - source.start, inserted);
        let before = &text[source.clone()];
        let raw_markdown = text[..source.start].ends_with("\"\"\"\n");
        if after.lines().any(|l| l.starts_with("# %%"))
            || (raw_markdown && after.contains("\"\"\"") && !before.contains("\"\"\""))
        {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use fresh_editor_core::model::event::CursorId;
    const DOC: &str = "# %% [markdown] id=m\nr\"\"\"\n# Hello é\"\"\"\n\n# %% id=c\nprint(42)\n";
    fn insert(at: usize, value: &str) -> Event {
        Event::Insert {
            position: at,
            text: value.into(),
            cursor_id: CursorId(0),
        }
    }
    fn delete(start: usize, end: usize) -> Event {
        Event::Delete {
            range: start..end,
            deleted_text: String::new(),
            cursor_id: CursorId(0),
        }
    }
    #[test]
    fn notebook_source_and_boundaries() {
        let md = DOC.find("# Hello").unwrap();
        let code = DOC.find("print").unwrap();
        assert!(edits_allowed(DOC, &[insert(md, "New\n")]));
        assert!(edits_allowed(DOC, &[insert(code + 9, "\nprint(7)")]));
        assert!(edits_allowed(DOC, &[delete(md, md + "# Hello é".len())]));
        assert!(!edits_allowed(DOC, &[insert(0, "x")]));
        assert!(!edits_allowed(DOC, &[delete(md - 1, md)]));
        assert!(!edits_allowed(DOC, &[delete(md, code)]));
        assert!(!edits_allowed(DOC, &[delete(code + 9, DOC.len())]));
        assert!(!edits_allowed(
            DOC,
            &[insert(md + "# Hello é".len(), "\"\"\"")]
        ));
        assert!(!edits_allowed(DOC, &[insert(code, "# %% id=bad\n")]));
        assert!(!edits_allowed(DOC, &[insert(DOC.len(), "outside")]));
    }
    #[test]
    fn notebook_empty_cells_and_unicode() {
        let empty = "# %% id=a\n\n# %% [markdown] id=b\nr\"\"\"\n\"\"\"\n";
        assert!(edits_allowed(empty, &[insert(10, "x")]));
        let md = empty.rfind("\"\"\"").unwrap();
        assert!(edits_allowed(empty, &[insert(md, "日本語")]));
        let at = DOC.find('é').unwrap();
        assert!(!edits_allowed(DOC, &[insert(at + 1, "x")]));
        assert!(edits_allowed(DOC, &[delete(at, at + 2)]));
    }
    #[test]
    fn notebook_multicursor_replacement_is_atomic() {
        let at = DOC.find("print").unwrap();
        assert!(edits_allowed(
            DOC,
            &[delete(at, at + 5), insert(at, "display")]
        ));
        assert!(!edits_allowed(DOC, &[insert(at, "ok"), insert(0, "bad")]));
        assert!(!edits_allowed("# %% id=a\n# %\n", &[insert(13, "%")]));
    }
}
