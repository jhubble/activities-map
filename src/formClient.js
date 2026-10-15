//console.log("loaded data");
function saveFormData() {
	const form = document.getElementById('myForm');
	if (!form) return;

	const formData = new FormData(form);
	const dataObject = Object.fromEntries(formData.entries());
	localStorage.setItem('formData', JSON.stringify(dataObject));
	if (dataObject.token) {
		localStorage.setItem('stravaToken', dataObject.token);
	}
}

function initializeFormState() {
	const form = document.getElementById('myForm');
	if (!form) return;

	const tokenInput = form.querySelector('[name="token"]');
	const pageToken = tokenInput?.value || '';
	const savedToken = localStorage.getItem('stravaToken');
	restoreFormData(form);
	if (tokenInput) {
		tokenInput.value = pageToken || savedToken || tokenInput.value;
		if (tokenInput.value) {
			localStorage.setItem('stravaToken', tokenInput.value);
		}
	}
	form.addEventListener('submit', saveFormData);
}

function setCurrentYearDefaults() {
	const form = document.getElementById('myForm');
	if (!form) return;

	const year = new Date().getFullYear();
	const values = {
		fromStamp: `${year}-01-01T00:00:00`,
		toStamp: '',
		location_center_lat: '',
		location_center_long: '',
		location_distance_lat: '',
		location_distance_long: '',
		type: 'Bike_Foot',
		checkForNewer: 'true',
		refresh: 'true',
		dedup: 'true',
		showHulls: 'true',
		includePrivate: 'true',
		tiles: 'osm',
		tolerance: '0.7'
	};

	for (const [name, value] of Object.entries(values)) {
		const field = form.querySelector(`[name="${name}"]`);
		if (field) field.value = value;
	}
	saveFormData();
}

function setNearSeattle() {
	const form = document.getElementById('myForm');
	if (!form) return;

	const values = {
		location_center_lat: '47.6',
		location_center_long: '-122.33',
		location_distance_lat: '2',
		location_distance_long: '2'
	};

	for (const [name, value] of Object.entries(values)) {
		const field = form.querySelector(`[name="${name}"]`);
		if (field) field.value = value;
	}
	saveFormData();
}

function setNearMe() {
	const status = document.getElementById('locationStatus');
	if (!navigator.geolocation) {
		if (status) status.textContent = 'Location is not available in this browser.';
		return;
	}

	if (status) status.textContent = 'Getting your location…';
	navigator.geolocation.getCurrentPosition(({ coords }) => {
		const form = document.getElementById('myForm');
		if (!form) return;

		const values = {
			location_center_lat: String(coords.latitude),
			location_center_long: String(coords.longitude),
			location_distance_lat: '2',
			location_distance_long: '2'
		};
		for (const [name, value] of Object.entries(values)) {
			const field = form.querySelector(`[name="${name}"]`);
			if (field) field.value = value;
		}
		saveFormData();
		if (status) status.textContent = 'Location fields updated.';
	}, (error) => {
		if (!status) return;
		status.textContent = error.code === error.PERMISSION_DENIED
			? 'Location permission was denied.'
			: 'Unable to get your location.';
	});
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
window.initializeFormState = initializeFormState;
window.setCurrentYearDefaults = setCurrentYearDefaults;
window.setNearSeattle = setNearSeattle;
window.setNearMe = setNearMe;
