const quantity = document.querySelector("#quantity");
const total = document.querySelector("#total");
quantity.addEventListener("input", () => {
  total.textContent = `$${(12 + Number(quantity.value)).toFixed(2)}`;
});
