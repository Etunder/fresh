//! Translate virtual Kitty placements into classic placements for WezTerm releases
//! without Unicode-placeholder support. Work from the final frame so scrolling,
//! splits and clipped image tiles use the same positions as the editor's text.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ratatui::{buffer::Buffer, style::Color};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

#[derive(Default)]
struct Image {
    width: u32,
    height: u32,
    cols: u32,
    rows: u32,
}

#[derive(Default)]
pub struct WeztermGraphics {
    images: HashMap<u32, Image>,
    painted: HashSet<u32>,
}

impl WeztermGraphics {
    pub fn from_env() -> Option<Self> {
        std::env::var("TERM_PROGRAM")
            .is_ok_and(|v| v.eq_ignore_ascii_case("wezterm"))
            .then(|| {
                tracing::info!("WezTerm direct image placement compatibility enabled");
                Self::default()
            })
    }

    /// Upload PNGs normally, but remember virtual placements instead of sending
    /// U=1 to WezTerm (which would display them at an arbitrary cursor position).
    pub fn filter(&mut self, commands: &[u8]) -> Vec<u8> {
        let text = String::from_utf8_lossy(commands);
        let mut rest = text.as_ref();
        let mut output = String::new();
        while let Some(start) = rest.find("\x1b_G") {
            output.push_str(&rest[..start]);
            rest = &rest[start..];
            let Some(end) = rest.find("\x1b\\") else {
                break;
            };
            let command = &rest[3..end];
            let (control, data) = command.split_once(';').unwrap_or((command, ""));
            let fields: HashMap<_, _> = control
                .split(',')
                .filter_map(|f| f.split_once('='))
                .collect();
            let number = |name| {
                fields
                    .get(name)
                    .and_then(|v| v.parse::<u32>().ok())
                    .unwrap_or(0)
            };
            let id = number("i");
            let mut forward = true;
            match fields.get("a").copied() {
                Some("t") if number("f") == 100 && id != 0 => {
                    if let Ok(png) = STANDARD.decode(data) {
                        if png.len() >= 24 && png.starts_with(b"\x89PNG\r\n\x1a\n") {
                            self.images.insert(
                                id,
                                Image {
                                    width: u32::from_be_bytes(png[16..20].try_into().unwrap()),
                                    height: u32::from_be_bytes(png[20..24].try_into().unwrap()),
                                    ..Image::default()
                                },
                            );
                        }
                    }
                }
                Some("p") if number("U") == 1 => {
                    if let Some(image) = self.images.get_mut(&id) {
                        image.cols = number("c");
                        image.rows = number("r");
                        forward = false;
                    }
                }
                Some("d") => match fields.get("d").copied() {
                    Some("I") => {
                        self.images.remove(&id);
                    }
                    Some("A") => self.images.clear(),
                    _ => {}
                },
                _ => {}
            }
            if forward {
                output.push_str(&rest[..end + 2]);
            }
            rest = &rest[end + 2..];
        }
        output.push_str(rest);
        output.into_bytes()
    }

    /// Replace placeholder glyphs with spaces in the text frame and paint their
    /// source slices afterward. Lowercase d=i removes placements, retaining PNG
    /// data, so cursor moves and scrolling do not require uploading images again.
    pub fn frame(&mut self, buffer: &mut Buffer) -> String {
        struct Placement {
            id: u32,
            row: u32,
            col: u32,
            x: u16,
            y: u16,
            cols: u16,
            rows: u16,
        }
        let mut output = String::from("\x1b7");
        for id in self.painted.drain() {
            let _ = write!(output, "\x1b_Ga=d,d=i,i={id},q=2\x1b\\");
        }
        let area = buffer.area;
        let mut placements: Vec<Placement> = Vec::new();
        for y in area.y..area.bottom() {
            let mut x = area.x;
            while x < area.right() {
                let Some((id, row, col)) = placeholder(&buffer[(x, y)]) else {
                    x += 1;
                    continue;
                };
                let Some(image) = self.images.get(&id) else {
                    x += 1;
                    continue;
                };
                if image.cols == 0 || image.rows == 0 || col >= image.cols || row >= image.rows {
                    x += 1;
                    continue;
                }
                let mut len = 1u16;
                while x + len < area.right()
                    && col + u32::from(len) < image.cols
                    && placeholder(&buffer[(x + len, y)]) == Some((id, row, col + u32::from(len)))
                {
                    len += 1;
                }
                for dx in 0..len {
                    buffer[(x + dx, y)].set_symbol(" ");
                }
                // Scale a contiguous image as one rectangle. Scaling each row
                // independently introduces filtering seams through the text.
                if let Some(previous) = placements.iter_mut().find(|p| {
                    p.id == id
                        && p.x == x
                        && p.col == col
                        && p.cols == len
                        && p.y + p.rows == y
                        && p.row + u32::from(p.rows) == row
                }) {
                    previous.rows += 1;
                } else {
                    placements.push(Placement {
                        id,
                        row,
                        col,
                        x,
                        y,
                        cols: len,
                        rows: 1,
                    });
                }
                x += len;
            }
        }
        for (index, p) in placements.iter().enumerate() {
            let image = &self.images[&p.id];
            let sx = u64::from(p.col) * u64::from(image.width) / u64::from(image.cols);
            let ex = u64::from(p.col + u32::from(p.cols)) * u64::from(image.width)
                / u64::from(image.cols);
            let sy = u64::from(p.row) * u64::from(image.height) / u64::from(image.rows);
            let ey = u64::from(p.row + u32::from(p.rows)) * u64::from(image.height)
                / u64::from(image.rows);
            if ex > sx && ey > sy {
                let _ = write!(output,
                    "\x1b[{};{}H\x1b_Ga=p,i={},p={},x={sx},y={sy},w={},h={},c={},r={},C=1,q=2\x1b\\",
                    p.y + 1, p.x + 1, p.id, index + 1, ex - sx, ey - sy, p.cols, p.rows);
                tracing::trace!(
                    id = p.id,
                    x = p.x,
                    y = p.y,
                    cols = p.cols,
                    rows = p.rows,
                    "WezTerm image rectangle placement"
                );
                self.painted.insert(p.id);
            }
        }
        output.push_str("\x1b8");
        output
    }
}

fn placeholder(cell: &ratatui::buffer::Cell) -> Option<(u32, u32, u32)> {
    let mut chars = cell.symbol().chars();
    if chars.next()? != '\u{10eeee}' {
        return None;
    }
    let row_mark = chars.next()? as u32;
    let row = MARKS.iter().position(|&c| c == row_mark)? as u32;
    let col_mark = chars.next()? as u32;
    let col = MARKS.iter().position(|&c| c == col_mark)? as u32;
    let Color::Rgb(r, g, b) = cell.fg else {
        return None;
    };
    Some((
        (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b),
        row,
        col,
    ))
}

const MARKS: &[u32] = &[
    0x305, 0x30D, 0x30E, 0x310, 0x312, 0x33D, 0x33E, 0x33F, 0x346, 0x34A, 0x34B, 0x34C, 0x350,
    0x351, 0x352, 0x357, 0x35B, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369, 0x36A, 0x36B,
    0x36C, 0x36D, 0x36E, 0x36F, 0x483, 0x484, 0x485, 0x486, 0x487, 0x592, 0x593, 0x594, 0x595,
    0x597, 0x598, 0x599, 0x59C, 0x59D, 0x59E, 0x59F, 0x5A0, 0x5A1, 0x5A8, 0x5A9, 0x5AB, 0x5AC,
    0x5AF, 0x5C4, 0x610, 0x611, 0x612, 0x613, 0x614, 0x615, 0x616, 0x617, 0x657, 0x658, 0x659,
    0x65A, 0x65B, 0x65D, 0x65E, 0x6D6, 0x6D7, 0x6D8, 0x6D9, 0x6DA, 0x6DB, 0x6DC, 0x6DF, 0x6E0,
    0x6E1, 0x6E2, 0x6E4, 0x6E7, 0x6E8, 0x6EB, 0x6EC, 0x730, 0x732, 0x733, 0x735, 0x736, 0x73A,
    0x73D, 0x73F, 0x740, 0x741, 0x743, 0x745, 0x747, 0x749, 0x74A, 0x7EB, 0x7EC, 0x7ED, 0x7EE,
    0x7EF, 0x7F0, 0x7F1, 0x7F3, 0x816, 0x817, 0x818, 0x819, 0x81B, 0x81C, 0x81D, 0x81E, 0x81F,
    0x820, 0x821, 0x822, 0x823, 0x825, 0x826, 0x827, 0x829, 0x82A, 0x82B, 0x82C, 0x82D, 0x951,
    0x953, 0x954, 0xF82, 0xF83, 0xF86, 0xF87, 0x135D, 0x135E, 0x135F, 0x17DD, 0x193A, 0x1A17,
    0x1A75, 0x1A76, 0x1A77, 0x1A78, 0x1A79, 0x1A7A, 0x1A7B, 0x1A7C, 0x1B6B, 0x1B6D, 0x1B6E, 0x1B6F,
    0x1B70, 0x1B71, 0x1B72, 0x1B73, 0x1CD0, 0x1CD1, 0x1CD2, 0x1CDA, 0x1CDB, 0x1CE0, 0x1DC0, 0x1DC1,
    0x1DC3, 0x1DC4, 0x1DC5, 0x1DC6, 0x1DC7, 0x1DC8, 0x1DC9, 0x1DCB, 0x1DCC, 0x1DD1, 0x1DD2, 0x1DD3,
    0x1DD4, 0x1DD5, 0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9, 0x1DDA, 0x1DDB, 0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF,
    0x1DE0, 0x1DE1, 0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DFE, 0x20D0, 0x20D1, 0x20D4, 0x20D5,
    0x20D6, 0x20D7, 0x20DB, 0x20DC, 0x20E1, 0x20E7, 0x20E9, 0x20F0, 0x2CEF, 0x2CF0, 0x2CF1, 0x2DE0,
    0x2DE1, 0x2DE2, 0x2DE3, 0x2DE4, 0x2DE5, 0x2DE6, 0x2DE7, 0x2DE8, 0x2DE9, 0x2DEA, 0x2DEB, 0x2DEC,
    0x2DED, 0x2DEE, 0x2DEF, 0x2DF0, 0x2DF1, 0x2DF2, 0x2DF3, 0x2DF4, 0x2DF5, 0x2DF6, 0x2DF7, 0x2DF8,
    0x2DF9, 0x2DFA, 0x2DFB, 0x2DFC, 0x2DFD, 0x2DFE, 0x2DFF, 0xA66F, 0xA67C, 0xA67D, 0xA6F0, 0xA6F1,
    0xA8E0, 0xA8E1, 0xA8E2, 0xA8E3, 0xA8E4, 0xA8E5, 0xA8E6, 0xA8E7, 0xA8E8, 0xA8E9, 0xA8EA, 0xA8EB,
    0xA8EC, 0xA8ED, 0xA8EE, 0xA8EF, 0xA8F0, 0xA8F1, 0xAAB0, 0xAAB2, 0xAAB3, 0xAAB7, 0xAAB8, 0xAABE,
    0xAABF, 0xAAC1, 0xFE20, 0xFE21, 0xFE22, 0xFE23, 0xFE24, 0xFE25, 0xFE26, 0x10A0F, 0x10A38,
    0x1D185, 0x1D186, 0x1D187, 0x1D188, 0x1D189, 0x1D1AA, 0x1D1AB, 0x1D1AC, 0x1D1AD, 0x1D242,
    0x1D243, 0x1D244,
];

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::layout::Rect;

    fn loaded() -> WeztermGraphics {
        let mut graphics = WeztermGraphics::default();
        let mut png = vec![0; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&80u32.to_be_bytes());
        png[20..24].copy_from_slice(&48u32.to_be_bytes());
        let upload = format!("\x1b_Ga=t,f=100,i=42,m=0;{}\x1b\\", STANDARD.encode(png));
        let commands = format!("{upload}\x1b_Ga=p,U=1,i=42,c=10,r=3,q=2\x1b\\");
        assert_eq!(graphics.filter(commands.as_bytes()), upload.as_bytes());
        graphics
    }
    fn cell(buffer: &mut Buffer, x: u16, y: u16, row: usize, col: usize) {
        buffer[(x, y)]
            .set_symbol(&format!(
                "\u{10eeee}{}{}",
                char::from_u32(MARKS[row]).unwrap(),
                char::from_u32(MARKS[col]).unwrap()
            ))
            .set_fg(Color::Rgb(0, 0, 42));
    }
    #[test]
    fn clipped_tiles_use_source_coordinates_and_leave_text_alone() {
        let mut graphics = loaded();
        let mut buffer = Buffer::empty(Rect::new(0, 0, 20, 8));
        buffer[(0, 0)].set_symbol("T");
        cell(&mut buffer, 5, 2, 1, 2);
        cell(&mut buffer, 6, 2, 1, 3);
        let commands = graphics.frame(&mut buffer);
        assert!(commands.contains("\x1b[3;6H"));
        assert!(commands.contains("x=16,y=16,w=16,h=16,c=2,r=1,C=1"));
        assert_eq!(buffer[(5, 2)].symbol(), " ");
        assert_eq!(buffer[(0, 0)].symbol(), "T");
    }
    #[test]
    fn leaving_an_image_removes_its_old_placements() {
        let mut graphics = loaded();
        let mut buffer = Buffer::empty(Rect::new(0, 0, 20, 8));
        cell(&mut buffer, 1, 1, 0, 0);
        graphics.frame(&mut buffer);
        let empty = graphics.frame(&mut buffer);
        assert!(empty.contains("a=d,d=i,i=42"));
        assert!(!empty.contains("a=p"));
        assert!(graphics.images.contains_key(&42));
    }
    #[test]
    fn other_terminal_commands_and_transmission_chunks_pass_through() {
        let mut graphics = loaded();
        let text = b"\x1b[2 q\x1b_Gm=0;AAAA\x1b\\";
        assert_eq!(graphics.filter(text), text);
        assert_eq!(
            graphics.filter(b"\x1b_Ga=d,d=I,i=42\x1b\\"),
            b"\x1b_Ga=d,d=I,i=42\x1b\\"
        );
        assert!(!graphics.images.contains_key(&42));
    }
    #[test]
    fn adjacent_rows_merge_without_combining_separate_splits() {
        let mut graphics = loaded();
        let mut buffer = Buffer::empty(Rect::new(0, 0, 30, 8));
        cell(&mut buffer, 1, 1, 0, 0);
        cell(&mut buffer, 15, 1, 0, 0);
        cell(&mut buffer, 1, 2, 1, 0);
        let commands = graphics.frame(&mut buffer);
        assert_eq!(commands.matches("a=p").count(), 2);
        assert!(commands.contains("p=2,"));
        assert!(commands.contains("h=32,c=1,r=2"));
    }
}
