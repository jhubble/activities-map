	//console.log("loaded data");
function saveFormData() {
	//console.log("saving");
    // 2. Get the form element itself
    const form = document.getElementById('myForm');

    // 3. Create a FormData object from the form
    // FormData automatically collects all named input elements and their values
    const formData = new FormData(form);

    // 4. Convert the FormData entries into a plain JavaScript object
    // Object.fromEntries() is the modern and concise way to do this
    const dataObject = Object.fromEntries(formData.entries());
    //console.log(dataObject);

    // Display the resulting object in the console
    // 2. Convert the object to a JSON string.
	const objectAsString = JSON.stringify(dataObject);

	// 3. Store the JSON string in local storage using a key.
	localStorage.setItem("formData", objectAsString);

    // The result will be an object like:
    // { user_name: '...', user_email: '...', subscribe: 'on', fav_color: '...' }
};

   function restoreFormData(form) {
	   if (!form) {
	   	form = document.getElementById('myForm');
	   }
	   //console.log("restoring form data");
      const savedData = localStorage.getItem('formData');
	   //console.log("saved data",savedData);
      if (savedData) {
        const data = JSON.parse(savedData);
        for (const key in data) {
		if (key === 'token') {
			continue;
		}

          const input = form.querySelector(`[name="${key}"]`);
          if (input) {
            if (input.type === 'checkbox' || input.type === 'radio') {
              input.checked = (input.value === data[key]);
            } else {
              input.value = data[key];
            }
          }
        }
      }
    }

