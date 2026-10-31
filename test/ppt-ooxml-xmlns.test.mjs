import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import PptxGenJS from 'pptxgenjs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { parsePptdProject, renderPptdProject } from '../packages/ppt-runtime/core/lib/pptd.js';
import { convertPptxToPptd } from '../packages/ppt-runtime/core/lib/pptx-converter.js';
import { flattenPptxGroups } from '../packages/ppt-runtime/core/lib/pptx-groups.js';
import { sanitizeOoXml, serializeOoXmlElement } from '../packages/ppt-runtime/core/lib/pptx-resources.js';

function installDomParser() {
  const window = new JSDOM('').window;
  const previous = globalThis.DOMParser;
  globalThis.DOMParser = window.DOMParser;
  return () => {
    window.close();
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'DOMParser');
    else globalThis.DOMParser = previous;
  };
}

const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

it('strips empty prefix namespace declarations that XML 1.0 forbids', () => {
  expect(sanitizeOoXml('<root xmlns:r="" xmlns:a=\'\' id="1"/>')).toBe('<root id="1"/>');
});

it('flattens slides that undeclare unused OOXML prefixes without throwing', () => {
  const restore = installDomParser();
  try {
    const parsed = new DOMParser().parseFromString(slideXml, 'application/xml');
    expect(parsed.querySelector('parsererror')?.textContent).toMatch(/undefine prefix/i);
    const flattened = flattenPptxGroups(slideXml);
    expect(flattened.count).toBe(0);
    expect(flattened.xml).not.toMatch(/xmlns:r\s*=\s*["']/);
    expect(new DOMParser().parseFromString(flattened.xml, 'application/xml').querySelector('parsererror')).toBeNull();
  } finally {
    restore();
  }
});

it('serializes documents after JSDOM adds empty prefix declarations', () => {
  const restore = installDomParser();
  try {
    const doc = new DOMParser().parseFromString(sanitizeOoXml(slideXml), 'application/xml');
    doc.documentElement.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:r', '');
    expect(() => doc.documentElement.outerHTML).toThrow(/undeclare a namespace/i);
    const xml = serializeOoXmlElement(doc.documentElement);
    expect(xml).toContain('p:sld');
    expect(xml).not.toMatch(/xmlns:r\s*=\s*["']/);
  } finally {
    restore();
  }
});

it('converts a PPTX whose XML undeclares unused prefixes, including grouped shapes', async () => {
  const pptx = new PptxGenJS();
  pptx.addSlide().addText('Prefix', { x: 1, y: 1, w: 4, h: 1, fontSize: 18, objectName: 'child' });
  const parts = unzipSync(Buffer.from(await pptx.write({ outputType: 'nodebuffer' })));
  const slidePath = 'ppt/slides/slide1.xml';
  let xml = strFromU8(parts[slidePath]);
  const shape = xml.match(/<p:sp>.*?<\/p:sp>/s)[0];
  const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="914400"/><a:chOff x="914400" y="914400"/><a:chExt cx="3657600" cy="914400"/></a:xfrm></p:grpSpPr>${shape}</p:grpSp>`;
  xml = xml.replace(shape, group);
  for (const key of Object.keys(parts)) {
    if (!/\.xml(?:\.rels)?$/i.test(key)) continue;
    const text = key === slidePath ? xml : strFromU8(parts[key]);
    parts[key] = strToU8(text.replace(/<([A-Za-z0-9:]+)(\s)/, '<$1 xmlns:unused=""$2'));
  }
  const converted = await convertPptxToPptd(zipSync(parts), 'prefix.pptx');
  expect(converted.slideCount).toBe(1);
  expect(converted.diagnostics.some(item => item.feature === 'group')).toBe(true);
});

it.each(['a', 'drawing'])('round-trips three pages with locally declared %s text namespaces', async prefix => {
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  for (let index = 1; index <= 3; index++) {
    const slide = pptx.addSlide();
    slide.addText(`模板验收 ${index}`, { x: 1, y: 1, w: 6, h: 1, fontFace: 'SimSun', fontSize: 24, bold: true, margin: 0 });
    slide.addText('Regular Latin', { x: 1, y: 3, w: 6, h: 1, fontFace: 'Times New Roman', fontSize: 18, margin: 0 });
  }
  const parts = unzipSync(Buffer.from(await pptx.write({ outputType: 'nodebuffer' })));
  // Legal local declarations occur in PowerPoint text bodies and inherited defaults.
  for (const [name, bytes] of Object.entries(parts)) {
    if (!/^ppt\/(slides|slideLayouts|slideMasters)\/.*\.xml$/.test(name)) continue;
    const xml = strFromU8(bytes).replace(/(<\/?)a:/g, `$1${prefix}:`).replace(/xmlns:a=/g, `xmlns:${prefix}=`);
    const dom = new JSDOM(xml, { contentType: 'application/xml' });
    try {
      const document = dom.window.document;
      for (const element of [document.documentElement, ...document.getElementsByTagName('*')]) {
        for (const attribute of [...element.attributes]) {
          if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/' && attribute.value === drawing) element.removeAttributeNode(attribute);
        }
      }
      // Re-serialization moves declarations onto the first DrawingML element in each island,
      // matching Office documents whose root declares only the presentation namespace.
      parts[name] = strToU8(new dom.window.XMLSerializer().serializeToString(document));
    } finally { dom.window.close(); }
  }
  const input = zipSync(parts);
  const window = new JSDOM('').window;
  const parser = new window.DOMParser();
  const validXml = xml => {
    const document = parser.parseFromString(xml, 'application/xml');
    expect(document.querySelector('parsererror')?.textContent).toBeUndefined();
    return document;
  };
  try {
    const converted = await convertPptxToPptd(input, 'local-namespaces.pptx');
    expect(converted.slideCount).toBe(3);
    const project = parsePptdProject(converted.source);
    for (const [index, page] of project.pages.entries()) {
      const texts = page.elements.filter(element => element.elementType === 'text');
      expect(texts.map(element => element.content.text).join('')).toContain(`模板验收 ${index + 1}`);
      for (const element of texts) {
        const body = validXml(element.content.nativeTextBody);
        expect(body.documentElement.localName).toBe('txBody');
        expect(body.documentElement.namespaceURI).toBe('http://schemas.openxmlformats.org/presentationml/2006/main');
        expect(body.getElementsByTagNameNS(drawing, 'bodyPr').length).toBe(1);
      }
      const heading = texts.find(element => element.content.text.includes('模板验收'));
      const properties = validXml(heading.content.nativeTextBody).getElementsByTagNameNS(drawing, 'rPr')[0];
      expect(properties.getAttribute('b')).toBe('1');
      expect(properties.getAttribute('sz')).toBe('2400');
    }
    const exported = await renderPptdProject(project);
    for (const [name, bytes] of Object.entries(unzipSync(exported.bytes))) {
      if (name.endsWith('.xml') || name.endsWith('.rels')) validXml(strFromU8(bytes));
    }
    const reopened = await convertPptxToPptd(exported.bytes, 'reopened.pptx');
    expect(reopened.slideCount).toBe(3);
    expect(parsePptdProject(reopened.source).pages.map(page => page.elements.filter(element => element.elementType === 'text').map(element => element.content.text).join('')).join('')).toContain('模板验收 3');
    const retried = await convertPptxToPptd(input, 'reselected.pptx');
    await expect(renderPptdProject(parsePptdProject(retried.source))).resolves.toHaveProperty('bytes');
  } finally { window.close(); }
});
