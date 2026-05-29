/**
 * SD Power Tools — Async SD generation
 *
 * /sd-async — generate images in background
 */

import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { substituteParams, generateQuietPrompt } from '../../../../script.js';
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
        callback: async (args, value) => handleAsyncGeneration(args, value),
    }));

    LOG('/sd-async registered successfully.');
});
