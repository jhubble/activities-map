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
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		saveFormData();
		const submitter = event.submitter;
		const action = submitter?.getAttribute('formaction') || form.getAttribute('action') || '/process';
		const actionUrl = new URL(action, window.location.href);
		const formData = new FormData(form);
		const params = new URLSearchParams(formData);
		const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		params.set('jobId', jobId);
		showProcessingStatus(actionUrl.pathname === '/stats' ? 'Starting detailed stats…' : 'Starting map generation…');
		const statusTimer = window.setInterval(async () => {
			try {
				const statusResponse = await fetch(`/progress/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
				if (statusResponse.ok) {
					const status = await statusResponse.json();
					showProcessingStatus(status.message);
				}
			} catch (_error) {
				showProcessingStatus('Still working…');
			}
		}, 700);
		fetch(`${actionUrl.pathname}?${params.toString()}`)
			.then(async (response) => {
				const body = await response.text();
				if (!response.ok) {
					const errorDocument = new DOMParser().parseFromString(body, 'text/html');
					throw new Error(errorDocument.body.textContent.trim() || `Request failed (${response.status})`);
				}
				return body;
			})
			.then((html) => {
				window.clearInterval(statusTimer);
				document.open();
				document.write(html);
				document.close();
			})
			.catch((error) => {
				window.clearInterval(statusTimer);
				showProcessingStatus(`Unable to finish: ${error.message}. Please try again.`);
			});
	});
}

function showProcessingStatus(message) {
	let panel = document.getElementById('processingStatus');
	if (!panel) {
		panel = document.createElement('div');
		panel.id = 'processingStatus';
		panel.className = 'processing-status';
		panel.setAttribute('role', 'status');
		panel.setAttribute('aria-live', 'polite');
		panel.innerHTML = '<span class="processing-spinner" aria-hidden="true"></span><span class="processing-message"></span>';
		document.body.appendChild(panel);
	}
	panel.querySelector('.processing-message').textContent = message;
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
window.showProcessingStatus = showProcessingStatus;
