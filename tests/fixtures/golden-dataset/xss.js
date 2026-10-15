// Intentionally vulnerable fixture for the golden-dataset regression suite.
// DO NOT use this pattern in real code.

function renderComment(comment) {
  const container = document.getElementById('comments');

  // VULNERABLE: user-controlled input inserted into the DOM without escaping (XSS)
  container.innerHTML += '<div class="comment">' + comment.author + ': ' + comment.text + '</div>';
}

function renderSearchResults(query, results) {
  // VULNERABLE: reflecting raw user input back into the page
  document.title = 'Results for ' + query;

  const html = results.map(r => `<li>${r.title}</li>`).join('');
  document.getElementById('results').innerHTML = html;
}

export { renderComment, renderSearchResults };
