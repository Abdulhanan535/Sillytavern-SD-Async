const VN_WRAPPER_ID = 'sd-vn-wrapper';

let wrapperCreated = false;

function ensureWrapper() {
    if (wrapperCreated) return;
    wrapperCreated = true;
    const $w = $(`<div id="${VN_WRAPPER_ID}" class="sd-vn-wrapper"><img class="sd-vn-sprite" src="" alt=""></div>`);
    $w.hide();
    $('body').append($w);
}

export function showVnSprite(url) {
    ensureWrapper();
    const $w = $(`#${VN_WRAPPER_ID}`);
    const $img = $w.find('.sd-vn-sprite');
    $img.attr('src', url || '');
    $w.toggle(!!url);
}
