import { descriptionText, sanitizeDescription } from './role-description.js';

describe('sanitizeDescription', () => {
  it('keeps the editor tag set', () => {
    expect(
      sanitizeDescription(
        '<p><b>Bold</b> <em>it</em></p><ul><li>One</li></ul><br>',
      ),
    ).toBe('<p><b>Bold</b> <em>it</em></p><ul><li>One</li></ul><br />');
  });

  it('drops scripts, styles, attributes and other tags', () => {
    expect(
      sanitizeDescription(
        '<h1 onclick="x()">Title</h1><script>alert(1)</script><style>p{}</style><p style="color:red">Hi</p>',
      ),
    ).toBe('Title<p>Hi</p>');
  });

  it('turns divs into paragraphs', () => {
    expect(sanitizeDescription('<div>Line</div>')).toBe('<p>Line</p>');
  });

  it('allows only http(s) and mailto links and adds rel', () => {
    expect(
      sanitizeDescription(
        '<a href="https://x.test">ok</a><a href="javascript:alert(1)">bad</a>',
      ),
    ).toBe(
      '<a href="https://x.test" rel="noopener noreferrer">ok</a><a rel="noopener noreferrer">bad</a>',
    );
  });
});

describe('descriptionText', () => {
  it('strips tags, keeps line breaks and decodes entities', () => {
    expect(
      descriptionText('<p>Fish &amp; chips</p><ul><li>A &lt; B</li></ul>'),
    ).toBe('Fish & chips\nA < B');
  });

  it('is empty for an empty description', () => {
    expect(descriptionText('')).toBe('');
  });
});
