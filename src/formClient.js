//console.log("loaded data");
function saveFormData() {
	const form = document.getElementById('myForm');
	if (!form) return;

	const formData = new FormData(form);
	const dataObject = Object.fromEntries(formData.entries());
	localStorage.setItem("formData", JSON.stringify(dataObject));
}

function restoreFormData(form) {
	if (!form) {
		form = document.getElementById('myForm');
	}
	if (!form) return;

	const savedData = localStorage.getItem('formData');
	if (savedData) {
		const data = JSON.parse(savedData);
		for (const key in data) {
			if (key === 'token') continue;

			const input = form.querySelector(`[name="${key}"]`);
			if (input) {
				if (input.type === 'checkbox' || input.type === 'radio') {
					input.checked = input.value === data[key];
				} else {
					input.value = data[key];
				}
			}
		}
	}
}

window.saveFormData = saveFormData;
window.restoreFormData = restoreFormData;
