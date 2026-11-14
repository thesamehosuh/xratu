import { expect, test } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
import { openPageNavigation, openWorkPanel } from './navigation';

for (const theme of ['dark','light'] as const) for (const locale of ['en','fa']) for (const width of [420,1440]) {
    test(`appearance controls and stable composer (${theme}, ${locale}, ${width})`, async ({page}, info) => {
        test.setTimeout(90_000);
        await installVscodeTheme(page,theme);
        await page.setViewportSize({width,height:950});
        await page.addInitScript(() => {
            let state: object = {};
            Object.assign(window,{acquireVsCodeApi:()=>({getState:()=>state,setState:(next:object)=>state=next,postMessage:()=>{}})});
        });
        await page.goto('/');
        const post=(message:object)=>page.evaluate(m=>window.postMessage(m,'*'),message);
        await post({type:'locale',locale}); await post({type:'showChat'});
        await post({type:'restoreUser',value:'Check this project'});
        await post({type:'startResponse'}); await post({type:'fullResponse',persian:'Ready.'});
        const input=page.locator('.composer-input');
        await input.fill('Retain this draft and selection');
        await input.evaluate(el=>{Object.assign(window,{originalInput:el});(el as HTMLTextAreaElement).setSelectionRange(2,6);});
        await page.locator('.msg.user').click();
        await expect(page.locator('.composer-actions')).toHaveCSS('height','0px');
        await page.locator('.attach-btn').click();
        await expect(page.locator('.attach-menu')).toBeVisible();
        await expect(page.locator('.composer-actions')).toHaveCSS('height','0px');
        await page.screenshot({animations:'disabled',path:info.outputPath('attachment-menu-collapsed.png')});
        await page.keyboard.press('Escape');
        await expect(page.locator('.composer-actions')).toHaveCSS('height','0px');
        await page.locator('.attach-btn').click();
        await expect(page.locator('.attach-menu')).toBeVisible();
        await page.locator('input[type=file]').setInputFiles({name:'context.ts',mimeType:'text/plain',buffer:Buffer.from('const x = 1;')});
        await expect(page.locator('.attach-chip')).toBeVisible();
        await expect(page.locator('.composer-actions')).toHaveCSS('height','36px');
        await page.keyboard.press('Escape'); await page.locator('.attach-chip-remove').click();
        await page.locator('.msg.user').click();
        await expect(page.locator('.composer-actions')).toHaveCSS('height','0px');
        if(width>860) {
            await page.locator('.toolbar > .sidebar-toggle').click();
            await openWorkPanel(page,'activity');
            await page.locator('#surface-tab-activity').press(locale==='fa'?'Control+Shift+ArrowLeft':'Control+Shift+ArrowRight');
            await expect(input).toBeVisible();
            await expect(page.locator('.composer-actions')).toHaveCSS('height','0px');
            // Track painted frames only while Conversation remains visible.
            await input.evaluate(el=>{const heights:number[]=[];Object.assign(window,{sampleHeights:heights,sampling:true});const sample=()=>{if(!(window as unknown as {sampling:boolean}).sampling)return;heights.push(el.getBoundingClientRect().height);requestAnimationFrame(sample);};requestAnimationFrame(sample);});
            const nav=page.locator('.navigation-resize');await nav.press('End');await nav.press('Home');
            const resize=page.locator('.review-resize');await resize.press('End');
            expect(Number(await resize.getAttribute('aria-valuenow'))).toBeGreaterThan(600);
            await resize.press('Home');
            await page.locator('.toolbar > .sidebar-toggle').click();
            await page.locator('.toolbar > .sidebar-toggle').click();
            const heights=await page.evaluate(()=>{const win=window as unknown as {sampling:boolean;sampleHeights:number[]};win.sampling=false;return win.sampleHeights;});
            expect(Math.max(...heights)-Math.min(...heights)).toBeLessThan(2);
            await page.screenshot({animations:'disabled',path:info.outputPath('wide-docking.png')});
        }
        expect(await input.evaluate(el=>el===(window as unknown as {originalInput:Element}).originalInput)).toBe(true);
        await post({type:'openSettings'});
        const navigate=async(section:string)=>{await openPageNavigation(page);await page.locator(`[data-section=${section}]`).click();};
        await navigate('appearance');
        const color=()=>page.locator('.appearance-page').evaluate(el=>getComputedStyle(el).color);
        const original=await color();
        await page.locator(theme==='dark'?'#appearance-lightContrast':'#appearance-darkContrast').press('End');
        expect(await color()).toBe(original);
        await page.locator(theme==='dark'?'#appearance-darkContrast':'#appearance-lightContrast').press('End');
        expect(await color()).not.toBe(original);
        await page.locator('.appearance-color-input').evaluate(el=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,'#cc2255');el.dispatchEvent(new Event('change',{bubbles:true}));});
        await expect(page.locator('.app')).toHaveAttribute('data-accent','custom');
        const custom = page.locator('.appearance-custom-swatch');
        await expect(custom).toHaveCSS('background-image', /conic-gradient/);
        await custom.hover();
        await expect(custom).toHaveCSS('background-image', /conic-gradient/);
        const slider = page.locator('#appearance-saturation');
        await slider.focus();
        await expect(slider).toHaveCSS('outline-style', 'none');
        await expect(slider).toHaveCSS('box-shadow', 'none');
        // Keyboard adjustment must not draw a rectangular outline around the thumb.
        const thumbOutlines = await slider.evaluate(() => [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule instanceof CSSStyleRule && /appearance-range input:focus-visible::-(webkit-slider|moz-range)-thumb/.test(rule.selectorText)).map(rule => (rule as CSSStyleRule).style.outline));
        expect(thumbOutlines.filter(value => value && value !== 'none')).toEqual([]);
        await page.locator('#appearance-saturation').press('Home');
        await expect(slider.locator('+ output')).toHaveCSS('text-decoration-line', 'underline');
        await expect(page.locator('#appearance-saturation')).toHaveValue('0');
        await page.locator('#appearance-saturation').press('End');
        await page.screenshot({animations:'disabled',path:info.outputPath('appearance.png')});
        await navigate('providers');
        await post({type:'oauthState',state:{providers:[{providerId:'chatgpt-codex',label:'ChatGPT',methods:['browser']}],accounts:[{providerId:'chatgpt-codex',credentialId:'oauth',accountLabel:'user@example.test',active:false,planEnabled:true}]}});
        const use=page.locator('.cred-oauth-use');await use.scrollIntoViewIfNeeded();
        const row=use.locator('..');const label=row.locator('.cred-oauth-account');
        const a=await use.boundingBox(),b=await label.boundingBox();expect(Math.abs(a!.y+a!.height/2-b!.y-b!.height/2)).toBeLessThan(2);
        await page.screenshot({animations:'disabled',path:info.outputPath('account-inline.png')});
        await navigate('proxy');
        await post({type:'proxyDetectResult',candidates:[{service:'Local proxy',url:'http://127.0.0.1:7890',ports:[{port:7890,protocol:'http',url:'http://127.0.0.1:7890',usable:true}]}]});
        const action=page.locator('.proxy-candidate .apply-btn');
        await action.scrollIntoViewIfNeeded();
        const border=await action.evaluate(el=>{const probe=document.createElement('span');probe.style.color='var(--xratu-action-border)';el.appendChild(probe);const expected=getComputedStyle(probe).color;probe.remove();return [getComputedStyle(el).borderTopColor,expected];});
        expect(border[0]).toBe(border[1]);
        await page.screenshot({animations:'disabled',path:info.outputPath('proxy-accent.png')});
    });
}
