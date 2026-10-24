const input = document.querySelector("#note");
const list = document.querySelector("#notes");
let notes = JSON.parse(localStorage.getItem("notes") || "[]");
function render() {
  list.replaceChildren();
  for (const note of notes) {
    const item = document.createElement("li");
    item.textContent = note;
    list.append(item);
  }
}
document.querySelector("#save").addEventListener("click", () => {
  if (!input.value.trim()) return;
  notes.push(input.value.trim());
  localStorage.setItem("notes", JSON.stringify(notes));
  input.value = "";
  render();
});
render();
