const fs = require('fs');
const content = fs.readFileSync('c:\\Users\\brasi\\Desktop\\pentfino\\index.html', 'utf8');

function checkTags(html) {
    const stack = [];
    const tags = html.match(/<\/?([a-z0-9]+)(\s|>)/gi);
    const selfClosing = ['img', 'br', 'hr', 'input', 'link', 'meta', 'svg', 'path', 'line', 'rect', 'polyline', 'circle'];
    
    tags.forEach(tag => {
        const isClosing = tag.startsWith('</');
        const tagName = tag.replace(/[<>\/]/g, '').split(' ')[0].toLowerCase();
        
        if (selfClosing.includes(tagName)) return;
        
        if (isClosing) {
            const last = stack.pop();
            if (last !== tagName) {
                console.log(`Mismatch: closed ${tagName} but expected ${last}`);
            }
        } else {
            stack.push(tagName);
        }
    });
    
    if (stack.length > 0) {
        console.log('Unclosed tags:', stack);
    } else {
        console.log('All tags balanced!');
    }
}

checkTags(content);
