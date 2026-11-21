(function () {
  const params = new URLSearchParams(window.location.search);
  const campaign = new URLSearchParams();
  // Match the intake allowlist. Never copy whole URLs, click IDs or form answers.
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_ida', 'utm_idf']) {
    const value = (params.get(key) || '').trim();
    if (/^[a-z0-9][a-z0-9_.:-]{0,79}$/i.test(value) &&
        (key === 'utm_ida' || key === 'utm_idf' || !/^[0-9]{10,13}$/.test(value))) {
      campaign.set(key, value);
    }
  }
  // Add only safe tags to the specific showing/question destination in this
  // browser. This keeps visitor-specific campaign data out of cached listing HTML.
  if (campaign.size) {
    for (const anchor of document.querySelectorAll('a[href^="/contact.html?intent="]')) {
      const destination = new URL(anchor.href);
      for (const [key, value] of campaign) destination.searchParams.set(key, value);
      anchor.href = destination.href;
    }
  }

  const form = document.forms.namedItem('contact');
  if (!form) return;
  for (const [key, value] of campaign) form.elements.namedItem(key).value = value;
  const intent = params.get('intent');
  const mls = params.get('mls') || '';
  if (!['showing', 'question'].includes(intent) || !/^[a-z0-9-]{1,32}$/i.test(mls)) return;

  const address = (params.get('address') || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const property = address ? address + ' (MLS ' + mls + ')' : 'MLS ' + mls;
  const showing = intent === 'showing';
  form.elements.namedItem('listing_address').value = address || property;
  form.elements.namedItem('listing_mls').value = mls;
  form.elements.namedItem('inquiry_type').value = showing ? 'Tour' : 'Question';
  document.querySelector('h1').textContent = (showing ? 'Request a showing for ' : 'Ask about ') + property;
  document.querySelector('.hero .lede').textContent = showing ?
    'Send Christine your preferred showing times or any questions about this property.' :
    'Send Christine your question about this property.';
  form.querySelector('button[type="submit"]').textContent = showing ? 'Send my showing request' : 'Send my question';
  if (showing) {
    const message = form.elements.namedItem('message');
    message.required = false;
    message.placeholder = 'Preferred times or questions (optional)';
  }
})();
