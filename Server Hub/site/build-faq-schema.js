'use strict'
// Rebuilds the FAQPage structured data in faq.html from the questions on the page,
// so what search engines read always matches what people see.
// Run after changing a question: node site/build-faq-schema.js
const fs = require('fs')
const path = require('path')

const file = path.join(__dirname, 'faq.html')
const html = fs.readFileSync(file, 'utf8')

const text = (s) => s
  .replace(/<\/(p|li)>/g, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim()

const items = []
const pattern = /<summary><h3>([\s\S]*?)<\/h3><\/summary>\s*<div class="answer">([\s\S]*?)<\/div>\s*<\/details>/g
for (const m of html.matchAll(pattern)) {
  items.push({ '@type': 'Question', name: text(m[1]), acceptedAnswer: { '@type': 'Answer', text: text(m[2]) } })
}
if (!items.length) throw new Error('No questions found in faq.html')

const schema = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items }, null, 2)
  .replace(/</g, '\\u003c')
const block = `<script type="application/ld+json">\n${schema}\n  </script>`
const out = html.replace(/(<!-- FAQ-SCHEMA:START[^>]*-->)[\s\S]*?(<!-- FAQ-SCHEMA:END -->)/, `$1\n  ${block}\n  $2`)
if (out === html && !html.includes(block)) throw new Error('FAQ-SCHEMA markers not found')
fs.writeFileSync(file, out)
console.log(`Wrote ${items.length} questions to the FAQPage data in faq.html`)
