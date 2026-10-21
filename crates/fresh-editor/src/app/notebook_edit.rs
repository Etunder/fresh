use super::notebook_edit_policy::edits_allowed;
use super::Editor;
use crate::model::event::Event;

impl Editor {
    pub(super) fn refuse_notebook_edits(&mut self, events: &[Event]) -> bool {
        if !events.iter().any(Event::modifies_buffer) {
            return false;
        }
        let notebook = self
            .active_window()
            .buffer_metadata
            .get(&self.active_buffer())
            .is_some_and(|meta| meta.is_notebook());
        if !notebook {
            return false;
        }
        let size = self.active_state().buffer.len();
        let text = self.active_state_mut().get_text_range(0, size);
        if edits_allowed(&text, events) {
            return false;
        }
        self.set_status_message("Notebook structure is protected. Edit cell text; use Alt+B / Alt+M to add cells, or F1 for actions.".to_string());
        true
    }
}
