/**
 * SD Power Tools — Async SD generation
 *
 * /sd-async — generate images in background
 */

import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { substituteParams, generateQuietPrompt, getRequestHeaders, extension_settings } from '../../../../script.js';
import { isTrueBoolean } from '../../../utils.js';
import { oai_settings, sendOpenAIRequest } from '../../../openai.js';
import { CONNECT_API_MAP } from '../../../slash-commands.js';
import { getContext } from '../../../extensions.js';

const EXT_NAME = 'sd-power-tools';
const LOG = (...args) => console.log(`[${EXT_NAME}]`, ...args);
const ERR = (...args) => console.error(`[${EXT_NAME}]`, ...args);

let _lockQueue = Promise.resolve();

function acquirePipelineLock() {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const wait = _lockQueue;
    _lockQueue = _lockQueue.then(() => next);
    return wait.then(() => release);
}

async function generateWithApi(apiName, promptText) {
    const config = CONNECT_API_MAP[apiName.toLowerCase()];
    if (!config || config.selected !== 'openai') {
        return String(await generateQuietPrompt({ quietPrompt: promptText }));
    }

    const release = await acquirePipelineLock();
    const originalSource = oai_settings.chat_completion_source;

    try {
        if (config.source) oai_settings.chat_completion_source = config.source;

        const processed = substituteParams(promptText);
        const messages = [{ role: 'user', content: processed }];
        const req = await sendOpenAIRequest('quiet', messages, null);

        if (typeof req === 'string') return req;
        if (typeof req === 'function') {
            let text = '';
            for await (const chunk of req()) {
                if (chunk?.text) text += chunk.text;
                else if (Array.isArray(chunk?.swipes) && chunk.swipes.length > 0) text = chunk.swipes[0];
            }
            return text;
        }

        const r = req;
        if (r?.choices?.[0]?.message?.content) return String(r.choices[0].message.content);
        if (r?.choices?.[0]?.text) return String(r.choices[0].text);
        if (r?.message?.content) {
            if (Array.isArray(r.message.content)) return String(r.message.content[0]?.text || '');
            return String(r.message.content);
        }
        if (r?.text) return String(r.text);
        if (r?.response) return String(r.response);
        if (r?.content) {
            if (Array.isArray(r.content)) return String(r.content[0]?.text || '');
            return String(r.content);
        }
        return '';
    } catch (e) {
        ERR('API-override generation failed:', e);
        throw e;
    } finally {
        oai_settings.chat_completion_source = originalSource;
        release();
    }
}

async function runPipeline(apiName, prompt1, prompt2, quiet) {
    const generate = apiName
        ? (text) => generateWithApi(apiName, text)
        : async (text) => String(await generateQuietPrompt({ quietPrompt: text }));

    let actionResult = '';
    if (prompt1) {
        LOG('Stage 1: generating action keywords...');
        if (!quiet) toastr.info('Generating action keywords...', 'SD Pipeline - Stage 1');
        actionResult = (await generate(String(prompt1)))?.trim() || '';
        LOG('Stage 1 result:', actionResult);
    }

    if (prompt2) {
        const stage2 = String(prompt2).replace(/\{\{action\}\}/gi, actionResult);
        LOG('Stage 2: generating full SD prompt...');
        if (!quiet) toastr.info('Generating final image prompt...', 'SD Pipeline - Stage 2');
        const result = (await generate(stage2))?.trim() || '';
        LOG('Stage 2 result:', result);
        return result;
    }

    return actionResult;
}

function buildComfyWorkflow(workflow, prompt, negative) {
    let w = workflow.replaceAll('"%prompt%"', JSON.stringify(prompt));
    w = w.replaceAll('"%negative_prompt%"', JSON.stringify(negative));
    const seed = extension_settings.sd.seed >= 0 ? extension_settings.sd.seed : Math.round(Math.random() * Number.MAX_SAFE_INTEGER);
    w = w.replaceAll('"%seed%"', JSON.stringify(seed));
    const denoising_strength = extension_settings.sd.denoising_strength === undefined ? 1.0 : extension_settings.sd.denoising_strength;
    w = w.replaceAll('"%denoise%"', JSON.stringify(denoising_strength));
    const clip_skip = isNaN(extension_settings.sd.clip_skip) ? -1 : -extension_settings.sd.clip_skip;
    w = w.replaceAll('"%clip_skip%"', JSON.stringify(clip_skip));
    ['model', 'vae', 'sampler', 'scheduler', 'steps', 'scale', 'width', 'height'].forEach((ph) => {
        w = w.replaceAll(`"%${ph}%"`, JSON.stringify(extension_settings.sd[ph]));
    });
    (extension_settings.sd.comfy_placeholders ?? []).forEach((ph) => {
        w = w.replaceAll(`"%${ph.find}%"`, JSON.stringify(substituteParams(ph.replace)));
    });
    return w;
}

async function generateComfyWs(prompt, negative) {
    const comfyUrl = String(extension_settings.sd.comfy_url || '').replace(/\/$/, '');
    if (!comfyUrl) throw new Error('ComfyUI URL is not configured (sd.comfy_url).');

    const wfResp = await fetch('/api/sd/comfy/workflow', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ file_name: extension_settings.sd.comfy_workflow }),
    });
    if (!wfResp.ok) throw new Error('Failed to load ComfyUI workflow.');
    const workflow = buildComfyWorkflow(await wfResp.text(), prompt, negative);

    const clientId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
    const wsProto = comfyUrl.startsWith('https') ? 'wss' : 'ws';
    const wsUrl = `${wsProto}://${new URL(comfyUrl).host}/ws?clientId=${clientId}`;

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = (e) => reject(new Error('ComfyUI websocket connection failed: ' + (e?.message || e)));
    });

    try {
        await fetch(`${comfyUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: JSON.parse(workflow), client_id: clientId }),
        });

        const chunks = [];
        let currentNode = '';
        const image = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ComfyUI generation timed out.')), 300000);
            ws.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'executing') {
                        const data = msg.data;
                        if (data.prompt_id && data.node === null) {
                            clearTimeout(timer);
                            resolve(chunks.length ? chunks : null);
                            return;
                        }
                        if (data.node) currentNode = data.node;
                    }
                    return;
                }
                // Binary frame from the SaveImageWebsocket node
                if (currentNode && chunks.length === 0) {
                    const blob = event.data.slice(8);
                    chunks.push(blob);
                }
            };
            ws.onerror = (e) => { clearTimeout(timer); reject(new Error('ComfyUI websocket error: ' + (e?.message || e))); };
        });

        if (!image) throw new Error('ComfyUI did not return an image.');
        const buf = await new Blob(image).arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        return `data:image/png;base64,${base64}`;
    } finally {
        try { ws.close(); } catch {}
    }
}

async function handleAsyncWs(args, value) {
    const isQuiet = isTrueBoolean(args?.quiet);
    const callbackVar = args?.callback ? String(args.callback) : '';
    const onCompleteQR = args?.onComplete ? String(args.onComplete) : '';
    const pipelineApi = args?.api ? String(args.api) : '';
    const pipelinePrompt1 = args?.prompt_1 ? String(args.prompt_1) : '';
    const pipelinePrompt2 = args?.prompt_2 ? String(args.prompt_2) : '';
    (async () => {
        try {
            let finalTrigger = String(value || '');

            if (pipelinePrompt1 || pipelinePrompt2) {
                const result = await runPipeline(pipelineApi, pipelinePrompt1, pipelinePrompt2, isQuiet);
                if (result) finalTrigger = result;
                if (!isQuiet) toastr.success('Requesting image...', 'SD Pipeline');
            }

            if (!isQuiet) toastr.info('Generating image (in-browser, no disk write)...', 'SD Pipeline');
            const dataUrl = await generateComfyWs(finalTrigger, String(args?.negative || ''));

            try {
                const { setLocalVariable } = await import('../../../variables.js');
                setLocalVariable('imgdata', dataUrl);
            } catch (e) { ERR('Failed to set imgdata variable:', e); }

            if (callbackVar) {
                try {
                    const { setLocalVariable } = await import('../../../variables.js');
                    setLocalVariable(callbackVar, dataUrl);
                } catch (e) { ERR('Failed to set callback variable:', e); }
            }

            const ctx = getContext();
            if (onCompleteQR) {
                try {
                    const { setLocalVariable } = await import('../../../variables.js');
                    setLocalVariable('sd_image_path', dataUrl);
                    await ctx.executeSlashCommandsWithOptions(`/run ${onCompleteQR}`);
                    if (!isQuiet) toastr.success(`Executed QR: ${onCompleteQR}`, 'Background Generation Complete');
                } catch (qrError) {
                    ERR('onComplete QR failed:', qrError);
                    if (!isQuiet) toastr.error(`Failed to run QR "${onCompleteQR}"`, 'QR Error');
                }
            } else if (!isQuiet) {
                const msg = callbackVar ? `Image saved to local variable: ${callbackVar}` : 'Background image generation complete';
                toastr.success(msg, 'Image Ready');
            }
        } catch (error) {
            ERR('Async WS generation failed:', error);
            if (!isQuiet) toastr.error('Background generation failed', 'Error');
        }
    })();

    return 'Generation started in background';
}

async function handleAsyncGeneration(args, value) {
    const isQuiet = isTrueBoolean(args?.quiet);
    const callbackVar = args?.callback ? String(args.callback) : '';
    const onCompleteQR = args?.onComplete ? String(args.onComplete) : '';
    const pipelineApi = args?.api ? String(args.api) : '';
    const pipelinePrompt1 = args?.prompt_1 ? String(args.prompt_1) : '';
    const pipelinePrompt2 = args?.prompt_2 ? String(args.prompt_2) : '';
    (async () => {
        try {
            let finalTrigger = String(value || '');

            if (pipelinePrompt1 || pipelinePrompt2) {
                const result = await runPipeline(pipelineApi, pipelinePrompt1, pipelinePrompt2, isQuiet);
                if (result) finalTrigger = result;
                if (!isQuiet) toastr.success('Requesting image...', 'SD Pipeline');
                args.extend = 'false';
            }

            try {
                const { setLocalVariable } = await import('../../../variables.js');
                setLocalVariable('imgdata', String(finalTrigger || ''));
                LOG('Set imgdata:', String(finalTrigger || ''));
            } catch (e) {
                ERR('Failed to set imgdata variable:', e);
            }

            const SD_ARGS = [
                'quiet', 'gallery', 'negative', 'extend', 'edit', 'multimodal',
                'seed', 'width', 'height', 'steps', 'cfg', 'skip', 'model',
                'sampler', 'scheduler', 'vae', 'upscaler', 'scale', 'hires',
                'denoise', '2ndpass', 'faces', 'processing', 'style',
            ];
            const cmdArgs = [];
            for (const key of SD_ARGS) {
                if (args[key] !== undefined && args[key] !== null) {
                    const val = String(args[key]);
                    cmdArgs.push(val.includes(' ') ? `${key}="${val}"` : `${key}=${val}`);
                }
            }

            const commandString = `/imagine ${cmdArgs.join(' ')} ${finalTrigger}`;
            LOG('Executing:', commandString);

            const ctx = getContext();
            const cmdResult = await ctx.executeSlashCommandsWithOptions(commandString);
            const imagePath = String(cmdResult?.pipe || '').replace(/\\/g, '/');

            if (callbackVar && imagePath) {
                try {
                    const { setLocalVariable } = await import('../../../variables.js');
                    setLocalVariable(callbackVar, String(imagePath));
                } catch (e) {
                    ERR('Failed to set callback variable:', e);
                }
            }

            if (onCompleteQR && imagePath) {
                try {
                    const { setLocalVariable } = await import('../../../variables.js');
                    setLocalVariable('sd_image_path', String(imagePath));
                    await ctx.executeSlashCommandsWithOptions(`/run ${onCompleteQR}`);
                    if (!isQuiet) toastr.success(`Executed QR: ${onCompleteQR}`, 'Background Generation Complete');
                } catch (qrError) {
                    ERR('onComplete QR failed:', qrError);
                    if (!isQuiet) toastr.error(`Failed to run QR "${onCompleteQR}"`, 'QR Error');
                }
            } else if (imagePath && !isQuiet) {
                const msg = callbackVar
                    ? `Image saved to local variable: ${callbackVar}`
                    : 'Background image generation complete';
                toastr.success(msg, 'Image Ready');
            }
        } catch (error) {
            ERR('Async generation failed:', error);
            if (!isQuiet) toastr.error('Background generation failed', 'Error');
        }
    })();

    return 'Generation started in background';
}

jQuery(async () => {
    const originalToastrInfo = toastr.info;
    toastr.info = function (message, title, options) {
        if (title === 'Image Generation' || (typeof message === 'string' && (message.includes('Generating an image') || message.includes('Generating image')))) {
            LOG('Silenced SD generation toast notification.');
            return null;
        }
        return originalToastrInfo.apply(this, arguments);
    };

    LOG('Registering /sd-async command...');

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sd-async',
        aliases: ['imagine-async', 'img-async'],
        returns: 'Status string indicating generation has started in background',
        helpString: 'Generates SD images asynchronously.',
        unnamedArgumentList: [
            new SlashCommandArgument('prompt', 'The image generation prompt or prompt template', [ARGUMENT_TYPE.STRING], true),
        ],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'callback',
                description: 'Local-variable name to store the generated image path',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.variables('local'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onComplete',
                description: 'Quick Reply (SetName.QRName) to execute after generation completes',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'api',
                description: 'API for LLM pipeline stages (e.g. "cohere"). Uses active API if omitted.',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'prompt_1',
                description: 'Stage-1 LLM prompt (action/keyword extraction). Result -> {{action}} in prompt_2.',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'prompt_2',
                description: 'Stage-2 LLM prompt (full SD prompt). Use {{action}} to inject Stage-1 result.',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            new SlashCommandNamedArgument(
                'quiet', 'whether to post the generated image to chat', [ARGUMENT_TYPE.BOOLEAN], false, false, 'false',
            ),
            new SlashCommandNamedArgument(
                'gallery', 'whether to save the generated image to the character gallery', [ARGUMENT_TYPE.BOOLEAN], false, false, 'true',
            ),
            new SlashCommandNamedArgument(
                'ws', 'generate via ComfyUI websocket (no disk write on host)', [ARGUMENT_TYPE.BOOLEAN], false, false, 'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'negative',
                description: 'negative prompt prefix',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'width',
                description: 'image width',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'height',
                description: 'image height',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'scale',
                description: 'hires upscale factor',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'cfg',
                description: 'CFG scale',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'steps',
                description: 'number of steps',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'seed',
                description: 'generation seed',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        callback: async (args, value) => {
            if (isTrueBoolean(args?.ws)) return handleAsyncWs(args, value);
            return handleAsyncGeneration(args, value);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sd-async-ws',
        aliases: ['imagine-ws', 'img-ws'],
        returns: 'Status string indicating generation has started in background',
        helpString: 'Generates ComfyUI images in-browser via websocket (SaveImageWebsocket). No image is written to the ComfyUI host disk.',
        unnamedArgumentList: [
            new SlashCommandArgument('prompt', 'The image generation prompt or prompt template', [ARGUMENT_TYPE.STRING], true),
        ],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'callback',
                description: 'Local-variable name to store the generated data: URL',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.variables('local'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onComplete',
                description: 'Quick Reply (SetName.QRName) to execute after generation completes',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'api',
                description: 'API for LLM pipeline stages (e.g. "cohere"). Uses active API if omitted.',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'prompt_1',
                description: 'Stage-1 LLM prompt (action/keyword extraction). Result -> {{action}} in prompt_2.',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'prompt_2',
                description: 'Stage-2 LLM prompt (full SD prompt). Use {{action}} to inject Stage-1 result.',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            new SlashCommandNamedArgument(
                'quiet', 'whether to show toasts', [ARGUMENT_TYPE.BOOLEAN], false, false, 'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'negative',
                description: 'negative prompt prefix',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'width',
                description: 'image width',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'height',
                description: 'image height',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'scale',
                description: 'hires upscale factor',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'cfg',
                description: 'CFG scale',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'steps',
                description: 'number of steps',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'seed',
                description: 'generation seed',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        callback: async (args, value) => handleAsyncWs(args, value),
    }));

    LOG('/sd-async registered successfully.');
});
