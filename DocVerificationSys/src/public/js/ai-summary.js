'use strict';

const summaryElement = document.getElementById('ai-summary-content');

if (summaryElement) {
  fetch(summaryElement.dataset.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-csrf-token': summaryElement.dataset.csrfToken,
    },
    body: JSON.stringify({}),
  })
    .then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The AI summary could not be generated.');
      summaryElement.textContent = data.summary;
    })
    .catch(error => {
      summaryElement.textContent = `AI summary unavailable: ${error.message}`;
    });
}
