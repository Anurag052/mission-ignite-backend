import { Injectable, Logger } from '@nestjs/common';

/**
 * 3D GTO Task Simulation API
 *
 * Provides structured scene configurations for the frontend to render using:
 *   - Three.js (rendering)
 *   - Cannon.js (physics)
 *   - WebGL (GPU acceleration)
 *
 * Each task type (PGT, HGT, FGT, Command Task, GPE) has:
 *   - Scene layout (obstacles, materials, boundaries)
 *   - Physics constraints (weights, rope lengths, plank sizes)
 *   - Win conditions (what needs to happen to complete the task)
 *   - AI GTO verbal cue points (when AI interrupts during execution)
 */

export interface Vec3 { x: number; y: number; z: number; }

export interface PhysicsBody {
    id: string;
    type: 'BOX' | 'CYLINDER' | 'SPHERE' | 'PLANE' | 'ROPE';
    position: Vec3;
    size: Vec3;                    // width, height, depth (or radius for sphere/cylinder)
    rotation: Vec3;                // euler angles in degrees
    mass: number;                  // kg (0 = static)
    material: string;              // texture/color reference
    isInteractable: boolean;       // can candidate interact with it
    label?: string;                // display name
    constraints?: string[];         // physics constraint IDs
}

export interface Obstacle {
    id: string;
    name: string;
    type: 'WALL' | 'DITCH' | 'RIVER' | 'ROPE_SWING' | 'BALANCE_BEAM' | 'TUNNEL' | 'STRUCTURE' | 'BOUNDARY';
    bodies: PhysicsBody[];
    isCrossable: boolean;          // can be traversed
    requiresTeamwork: boolean;     // needs multiple people
    difficultyRating: number;      // 1-10
}

export interface AvailableMaterial {
    id: string;
    name: string;
    body: PhysicsBody;
    quantity: number;
    restrictions: string[];        // e.g. "Cannot touch the ground in colored zone"
}

export interface GtoCuePoint {
    triggerType: 'TIME' | 'EVENT' | 'PROGRESS';
    triggerValue: number | string; // seconds or event name
    text: string;                  // what AI GTO says
    pressureLevel: number;         // 1-5
}

export interface TaskScene {
    taskType: string;
    name: string;
    description: string;
    briefing: string;              // AI GTO opening instructions
    timeLimit: number;             // seconds
    groupSize: number;
    groundSize: Vec3;              // play area dimensions
    obstacles: Obstacle[];
    materials: AvailableMaterial[];
    spawnPoints: Vec3[];           // where candidates start
    winConditions: string[];
    rules: string[];
    aiCuePoints: GtoCuePoint[];
    cameraDefault: { position: Vec3; lookAt: Vec3 };
    lighting: { ambient: number; directional: { position: Vec3; intensity: number } };
    skybox: 'OUTDOOR_DAY' | 'OUTDOOR_OVERCAST' | 'INDOOR_GYM' | 'NIGHT';
}

@Injectable()
export class SimulationScenesService {
    private readonly logger = new Logger(SimulationScenesService.name);

    getScene(taskType: string, difficulty: 'STANDARD' | 'HARD' | 'EXTREME' = 'STANDARD'): TaskScene {
        switch (taskType) {
            case 'PGT': return this.buildPGT(difficulty);
            case 'HGT': return this.buildHGT(difficulty);
            case 'FGT': return this.buildFGT(difficulty);
            case 'COMMAND_TASK': return this.buildCommandTask(difficulty);
            case 'GPE': return this.buildGPE(difficulty);
            default: return this.buildPGT(difficulty);
        }
    }

    getAllScenes(): Array<{ taskType: string; name: string; description: string }> {
        return [
            { taskType: 'PGT', name: 'Progressive Group Task', description: 'Cross a series of 4 obstacles with limited materials — each harder than the last' },
            { taskType: 'HGT', name: 'Half Group Task', description: 'Half the group crosses a complex obstacle using ropes and planks' },
            { taskType: 'FGT', name: 'Final Group Task', description: 'Full group crosses a challenging obstacle — last chance to demonstrate leadership' },
            { taskType: 'COMMAND_TASK', name: 'Command Task', description: 'One candidate commands the rest as subordinates to complete a task' },
            { taskType: 'GPE', name: 'Group Planning Exercise', description: 'Study a terrain model and present your tactical plan' },
        ];
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // PGT — Progressive Group Task
    // ═══════════════════════════════════════════════════════════════════════════════

    private buildPGT(difficulty: string): TaskScene {
        const hardMode = difficulty !== 'STANDARD';
        const extremeMode = difficulty === 'EXTREME';

        return {
            taskType: 'PGT',
            name: 'Progressive Group Task',
            description: 'Cross 4 progressive obstacles using limited materials. Each obstacle is harder than the last.',
            briefing: 'Your group must cross from the start zone to the finish zone. You have 4 obstacles. Materials are limited — you may carry them forward. Any material touching a color zone is lost. No jumping. Begin planning.',
            timeLimit: hardMode ? 480 : 600, // 8 or 10 min
            groupSize: hardMode ? 8 : 10,
            groundSize: { x: 40, y: 0, z: 15 },
            obstacles: [
                // Obstacle 1: Simple ditch
                {
                    id: 'obs-1',
                    name: 'Ditch Alpha',
                    type: 'DITCH',
                    bodies: [
                        { id: 'ditch-1', type: 'BOX', position: { x: 8, y: -1, z: 7.5 }, size: { x: 3, y: 2, z: 15 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'brown_dirt', isInteractable: false },
                    ],
                    isCrossable: true,
                    requiresTeamwork: true,
                    difficultyRating: 3,
                },
                // Obstacle 2: River with boundaries
                {
                    id: 'obs-2',
                    name: 'River Bravo',
                    type: 'RIVER',
                    bodies: [
                        { id: 'river-1', type: 'BOX', position: { x: 18, y: -0.5, z: 7.5 }, size: { x: 4, y: 1, z: 15 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'blue_water', isInteractable: false },
                        { id: 'river-wall-l', type: 'BOX', position: { x: 16, y: 1, z: 0 }, size: { x: 0.5, y: 2, z: 0.5 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'concrete_grey', isInteractable: false },
                        { id: 'river-wall-r', type: 'BOX', position: { x: 20, y: 1, z: 0 }, size: { x: 0.5, y: 2, z: 0.5 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'concrete_grey', isInteractable: false },
                    ],
                    isCrossable: true,
                    requiresTeamwork: true,
                    difficultyRating: 5,
                },
                // Obstacle 3: Wall
                {
                    id: 'obs-3',
                    name: 'Wall Charlie',
                    type: 'WALL',
                    bodies: [
                        { id: 'wall-1', type: 'BOX', position: { x: 28, y: 1.5, z: 7.5 }, size: { x: 1, y: 3, z: 10 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'brick_red', isInteractable: false },
                    ],
                    isCrossable: true,
                    requiresTeamwork: true,
                    difficultyRating: 7,
                },
                // Obstacle 4: Combined (extreme only adds this)
                ...(extremeMode ? [{
                    id: 'obs-4',
                    name: 'Fortress Delta',
                    type: 'STRUCTURE' as const,
                    bodies: [
                        { id: 'struct-floor', type: 'BOX' as const, position: { x: 36, y: 2, z: 7.5 }, size: { x: 4, y: 0.3, z: 6 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'metal_dark', isInteractable: false },
                        { id: 'struct-wall', type: 'BOX' as const, position: { x: 38, y: 1, z: 7.5 }, size: { x: 0.5, y: 4, z: 6 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'metal_dark', isInteractable: false },
                    ],
                    isCrossable: true,
                    requiresTeamwork: true,
                    difficultyRating: 9,
                }] : []),
            ],
            materials: [
                {
                    id: 'plank-1', name: 'Plank (3m)', quantity: 2,
                    body: { id: 'plank-body-1', type: 'BOX', position: { x: 2, y: 0.1, z: 3 }, size: { x: 3, y: 0.1, z: 0.3 }, rotation: { x: 0, y: 0, z: 0 }, mass: 15, material: 'wood_dark', isInteractable: true },
                    restrictions: ['Cannot touch colored ground zones'],
                },
                {
                    id: 'plank-2', name: 'Plank (2m)', quantity: 1,
                    body: { id: 'plank-body-2', type: 'BOX', position: { x: 2, y: 0.1, z: 5 }, size: { x: 2, y: 0.1, z: 0.3 }, rotation: { x: 0, y: 0, z: 0 }, mass: 10, material: 'wood_light', isInteractable: true },
                    restrictions: ['Cannot touch colored ground zones'],
                },
                {
                    id: 'rope-1', name: 'Rope (5m)', quantity: 1,
                    body: { id: 'rope-body-1', type: 'ROPE', position: { x: 2, y: 0.3, z: 7 }, size: { x: 5, y: 0.05, z: 0.05 }, rotation: { x: 0, y: 0, z: 0 }, mass: 2, material: 'rope_brown', isInteractable: true },
                    restrictions: [],
                },
                {
                    id: 'drum-1', name: 'Oil Drum', quantity: hardMode ? 1 : 2,
                    body: { id: 'drum-body-1', type: 'CYLINDER', position: { x: 2, y: 0.3, z: 10 }, size: { x: 0.3, y: 0.6, z: 0.3 }, rotation: { x: 0, y: 0, z: 0 }, mass: 20, material: 'metal_rust', isInteractable: true },
                    restrictions: ['Group member can stand on it but it may roll'],
                },
            ],
            spawnPoints: Array.from({ length: 10 }, (_, i) => ({ x: 0, y: 0.5, z: 1.5 * i })),
            winConditions: [
                'All group members must cross to the finish zone',
                'All materials must be preserved (not lost to color zones)',
                'Complete within the time limit',
            ],
            rules: [
                'No jumping over obstacles',
                'Materials touching colored ground zones are forfeited',
                'Every group member must participate',
                'If any member touches the "danger zone" they must restart from the last safe point',
            ],
            aiCuePoints: [
                { triggerType: 'TIME', triggerValue: 30, text: 'I don\'t see a plan yet. What are you doing?', pressureLevel: 2 },
                { triggerType: 'TIME', triggerValue: 120, text: 'You\'re 2 minutes in and half your group is standing idle. Fix it.', pressureLevel: 3 },
                { triggerType: 'PROGRESS', triggerValue: 'obstacle_1_reached', text: 'That took too long. Pick up the pace.', pressureLevel: 2 },
                { triggerType: 'EVENT', triggerValue: 'material_lost', text: 'You just lost a material. Now what? Your plan just got harder.', pressureLevel: 4 },
                { triggerType: 'TIME', triggerValue: 300, text: 'Half your time is gone. I count 2 obstacles remaining. Do the math.', pressureLevel: 4 },
                { triggerType: 'TIME', triggerValue: 480, text: 'Two minutes left. This is your final chance. Execute or fail.', pressureLevel: 5 },
            ],
            cameraDefault: { position: { x: 20, y: 15, z: -5 }, lookAt: { x: 20, y: 0, z: 7.5 } },
            lighting: { ambient: 0.4, directional: { position: { x: 10, y: 20, z: 10 }, intensity: 0.8 } },
            skybox: 'OUTDOOR_DAY',
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HGT — Half Group Task
    // ═══════════════════════════════════════════════════════════════════════════════

    private buildHGT(difficulty: string): TaskScene {
        return {
            taskType: 'HGT',
            name: 'Half Group Task',
            description: 'Half the group crosses a single complex obstacle — demonstrates team coordination with limited members.',
            briefing: 'This is a Half Group Task. Only 5 of you will work. The rest observe. You have limited materials. Cross the obstacle to the finish marker. Time starts now.',
            timeLimit: difficulty === 'EXTREME' ? 360 : 480,
            groupSize: 5,
            groundSize: { x: 20, y: 0, z: 12 },
            obstacles: [
                {
                    id: 'hgt-obs-1',
                    name: 'Ravine',
                    type: 'DITCH',
                    bodies: [
                        { id: 'hgt-ravine', type: 'BOX', position: { x: 10, y: -2, z: 6 }, size: { x: 5, y: 4, z: 12 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'earth_dark', isInteractable: false },
                        { id: 'hgt-pole-l', type: 'CYLINDER', position: { x: 7, y: 1.5, z: 3 }, size: { x: 0.1, y: 3, z: 0.1 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'metal_grey', isInteractable: false, label: 'Left post' },
                        { id: 'hgt-pole-r', type: 'CYLINDER', position: { x: 13, y: 1.5, z: 3 }, size: { x: 0.1, y: 3, z: 0.1 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'metal_grey', isInteractable: false, label: 'Right post' },
                    ],
                    isCrossable: true,
                    requiresTeamwork: true,
                    difficultyRating: 6,
                },
            ],
            materials: [
                { id: 'plank-hgt', name: 'Plank (4m)', quantity: 1, body: { id: 'hgt-plank', type: 'BOX', position: { x: 3, y: 0.1, z: 6 }, size: { x: 4, y: 0.1, z: 0.3 }, rotation: { x: 0, y: 0, z: 0 }, mass: 18, material: 'wood_dark', isInteractable: true }, restrictions: ['Cannot touch the ravine floor'] },
                { id: 'rope-hgt', name: 'Rope (6m)', quantity: 1, body: { id: 'hgt-rope', type: 'ROPE', position: { x: 3, y: 0.3, z: 8 }, size: { x: 6, y: 0.05, z: 0.05 }, rotation: { x: 0, y: 0, z: 0 }, mass: 3, material: 'rope_brown', isInteractable: true }, restrictions: [] },
            ],
            spawnPoints: Array.from({ length: 5 }, (_, i) => ({ x: 1, y: 0.5, z: 2 * i + 1 })),
            winConditions: ['All 5 members cross the ravine', 'No member touches the ravine floor', 'Materials retrieved'],
            rules: ['Materials touching ravine floor are lost', 'All members must cross', 'No climbing the posts'],
            aiCuePoints: [
                { triggerType: 'TIME', triggerValue: 20, text: 'Who is leading? I don\'t see a leader. Decide NOW.', pressureLevel: 2 },
                { triggerType: 'TIME', triggerValue: 180, text: 'You should be halfway done. Are you?', pressureLevel: 3 },
                { triggerType: 'EVENT', triggerValue: 'member_fell', text: 'One of your team fell in. That\'s a casualty. Continue with what you have.', pressureLevel: 4 },
            ],
            cameraDefault: { position: { x: 10, y: 10, z: -3 }, lookAt: { x: 10, y: 0, z: 6 } },
            lighting: { ambient: 0.35, directional: { position: { x: 5, y: 15, z: 5 }, intensity: 0.7 } },
            skybox: 'OUTDOOR_OVERCAST',
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FGT — Final Group Task
    // ═══════════════════════════════════════════════════════════════════════════════

    private buildFGT(difficulty: string): TaskScene {
        return {
            taskType: 'FGT',
            name: 'Final Group Task',
            description: 'The final and most challenging obstacle — tests leadership emergence under maximum pressure.',
            briefing: 'Listen carefully. This is your FINAL task. I have watched you for days. This is your LAST chance to impress. You have 15 minutes. Cross the structure. Every member. No materials left behind. GO.',
            timeLimit: difficulty === 'EXTREME' ? 720 : 900,
            groupSize: 10,
            groundSize: { x: 30, y: 0, z: 15 },
            obstacles: [
                {
                    id: 'fgt-complex',
                    name: 'Fortress Complex',
                    type: 'STRUCTURE',
                    bodies: [
                        { id: 'fgt-wall-1', type: 'BOX', position: { x: 10, y: 2, z: 7.5 }, size: { x: 1, y: 4, z: 12 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'concrete_dark', isInteractable: false },
                        { id: 'fgt-ditch', type: 'BOX', position: { x: 16, y: -1.5, z: 7.5 }, size: { x: 4, y: 3, z: 12 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'mud_brown', isInteractable: false },
                        { id: 'fgt-platform', type: 'BOX', position: { x: 22, y: 1.5, z: 7.5 }, size: { x: 3, y: 0.3, z: 4 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'metal_platform', isInteractable: false },
                        { id: 'fgt-wall-2', type: 'BOX', position: { x: 27, y: 1.5, z: 7.5 }, size: { x: 0.5, y: 3, z: 8 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'brick_dark', isInteractable: false },
                    ],
                    isCrossable: true,
                    requiresTeamwork: true,
                    difficultyRating: 9,
                },
            ],
            materials: [
                { id: 'fgt-plank-1', name: 'Long Plank (4m)', quantity: 2, body: { id: 'fgt-p1', type: 'BOX', position: { x: 2, y: 0.1, z: 4 }, size: { x: 4, y: 0.1, z: 0.3 }, rotation: { x: 0, y: 0, z: 0 }, mass: 18, material: 'wood_dark', isInteractable: true }, restrictions: [] },
                { id: 'fgt-rope', name: 'Rope (8m)', quantity: 2, body: { id: 'fgt-r1', type: 'ROPE', position: { x: 2, y: 0.3, z: 8 }, size: { x: 8, y: 0.05, z: 0.05 }, rotation: { x: 0, y: 0, z: 0 }, mass: 4, material: 'rope_brown', isInteractable: true }, restrictions: [] },
                { id: 'fgt-drum', name: 'Oil Drum', quantity: 1, body: { id: 'fgt-d1', type: 'CYLINDER', position: { x: 2, y: 0.3, z: 11 }, size: { x: 0.3, y: 0.6, z: 0.3 }, rotation: { x: 0, y: 0, z: 0 }, mass: 20, material: 'metal_rust', isInteractable: true }, restrictions: [] },
            ],
            spawnPoints: Array.from({ length: 10 }, (_, i) => ({ x: 0, y: 0.5, z: 1.5 * i })),
            winConditions: ['All 10 members cross the Fortress Complex', 'All materials retrieved', 'Complete in time'],
            rules: ['No jumping', 'Touching mud/ground in danger zone = restart from last checkpoint', 'Everyone participates'],
            aiCuePoints: [
                { triggerType: 'TIME', triggerValue: 15, text: 'I want a commander to step up. RIGHT NOW. Don\'t waste my time.', pressureLevel: 3 },
                { triggerType: 'TIME', triggerValue: 120, text: 'Two minutes and you haven\'t even reached the first wall. Pathetic.', pressureLevel: 4 },
                { triggerType: 'TIME', triggerValue: 450, text: 'Halfway done. I\'m not impressed. Show me something.', pressureLevel: 4 },
                { triggerType: 'EVENT', triggerValue: 'member_fell', text: 'Casualty down! Your plan failed that person. What do you do now?', pressureLevel: 5 },
                { triggerType: 'TIME', triggerValue: 780, text: 'Two minutes left. TWO MINUTES. I see panic in your eyes. Prove me wrong.', pressureLevel: 5 },
            ],
            cameraDefault: { position: { x: 15, y: 12, z: -5 }, lookAt: { x: 15, y: 0, z: 7.5 } },
            lighting: { ambient: 0.3, directional: { position: { x: 10, y: 20, z: 5 }, intensity: 0.9 } },
            skybox: 'OUTDOOR_DAY',
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // Command Task
    // ═══════════════════════════════════════════════════════════════════════════════

    private buildCommandTask(difficulty: string): TaskScene {
        return {
            taskType: 'COMMAND_TASK',
            name: 'Command Task',
            description: 'You are the sole commander. Subordinates follow only your orders. Demonstrate individual leadership.',
            briefing: 'You are the commander. The others are your subordinates. They will do ONLY what you tell them. No suggestions from them. I want to see your planning, delegation, and execution. Impress me. Start.',
            timeLimit: difficulty === 'EXTREME' ? 360 : 480,
            groupSize: 4,
            groundSize: { x: 15, y: 0, z: 10 },
            obstacles: [
                {
                    id: 'ct-obs',
                    name: 'The Gap',
                    type: 'DITCH',
                    bodies: [
                        { id: 'ct-gap', type: 'BOX', position: { x: 7.5, y: -1, z: 5 }, size: { x: 3.5, y: 2, z: 10 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'earth_dark', isInteractable: false },
                        { id: 'ct-post', type: 'CYLINDER', position: { x: 7.5, y: 1, z: 5 }, size: { x: 0.15, y: 2, z: 0.15 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'wood_post', isInteractable: false, label: 'Center post' },
                    ],
                    isCrossable: true,
                    requiresTeamwork: true,
                    difficultyRating: 7,
                },
            ],
            materials: [
                { id: 'ct-plank', name: 'Plank (2.5m)', quantity: 2, body: { id: 'ct-p1', type: 'BOX', position: { x: 1, y: 0.1, z: 3 }, size: { x: 2.5, y: 0.1, z: 0.25 }, rotation: { x: 0, y: 0, z: 0 }, mass: 12, material: 'wood_dark', isInteractable: true }, restrictions: ['Cannot touch gap floor'] },
                { id: 'ct-rope', name: 'Rope (4m)', quantity: 1, body: { id: 'ct-r1', type: 'ROPE', position: { x: 1, y: 0.3, z: 6 }, size: { x: 4, y: 0.05, z: 0.05 }, rotation: { x: 0, y: 0, z: 0 }, mass: 2, material: 'rope_brown', isInteractable: true }, restrictions: [] },
            ],
            spawnPoints: [{ x: 1, y: 0.5, z: 2 }, { x: 1, y: 0.5, z: 4 }, { x: 1, y: 0.5, z: 6 }, { x: 1, y: 0.5, z: 8 }],
            winConditions: ['All 4 members cross', 'Materials retrieved', 'Commander gives clear orders throughout'],
            rules: ['Subordinates follow ONLY commander\'s orders', 'No initiative from subordinates unless commanded', 'Commander must verbally direct every action'],
            aiCuePoints: [
                { triggerType: 'TIME', triggerValue: 10, text: 'Commander, I\'m waiting. What\'s your plan?', pressureLevel: 2 },
                { triggerType: 'TIME', triggerValue: 60, text: 'Your subordinates look confused. Are your orders clear?', pressureLevel: 3 },
                { triggerType: 'TIME', triggerValue: 180, text: 'An officer should have solved this by now. What\'s holding you up?', pressureLevel: 4 },
                { triggerType: 'TIME', triggerValue: 360, text: 'Two minutes left, commander. Lead or fail.', pressureLevel: 5 },
            ],
            cameraDefault: { position: { x: 7.5, y: 8, z: -3 }, lookAt: { x: 7.5, y: 0, z: 5 } },
            lighting: { ambient: 0.4, directional: { position: { x: 5, y: 12, z: 8 }, intensity: 0.75 } },
            skybox: 'OUTDOOR_DAY',
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // GPE — Group Planning Exercise
    // ═══════════════════════════════════════════════════════════════════════════════

    private buildGPE(difficulty: string): TaskScene {
        return {
            taskType: 'GPE',
            name: 'Group Planning Exercise',
            description: 'Study a terrain model showing a military scenario. Plan a tactical response and present it.',
            briefing: 'Study this terrain model carefully. You have 5 minutes to read the situation. Then each of you will present your individual plan for 2 minutes. I want clear, logical, decisive plans. Not essays — action plans.',
            timeLimit: 900,   // 15 min total (5 read + 10 present)
            groupSize: 10,
            groundSize: { x: 30, y: 0, z: 30 },
            obstacles: [
                // Terrain model elements
                {
                    id: 'gpe-river',
                    name: 'River (obstacle on terrain)',
                    type: 'RIVER',
                    bodies: [
                        { id: 'gpe-river-body', type: 'BOX', position: { x: 15, y: 0.05, z: 20 }, size: { x: 30, y: 0.1, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'blue_water_shallow', isInteractable: false },
                    ],
                    isCrossable: false,
                    requiresTeamwork: false,
                    difficultyRating: 0,
                },
                {
                    id: 'gpe-hill',
                    name: 'Hill (terrain feature)',
                    type: 'STRUCTURE',
                    bodies: [
                        { id: 'gpe-hill-body', type: 'SPHERE', position: { x: 10, y: 2, z: 10 }, size: { x: 4, y: 2, z: 4 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'green_terrain', isInteractable: false, label: 'Hill 312m' },
                    ],
                    isCrossable: false,
                    requiresTeamwork: false,
                    difficultyRating: 0,
                },
                {
                    id: 'gpe-village',
                    name: 'Village (population center)',
                    type: 'STRUCTURE',
                    bodies: [
                        { id: 'gpe-v1', type: 'BOX', position: { x: 22, y: 0.5, z: 8 }, size: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'building_beige', isInteractable: false, label: 'Village A' },
                        { id: 'gpe-v2', type: 'BOX', position: { x: 23.5, y: 0.5, z: 9 }, size: { x: 1.2, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'building_beige', isInteractable: false },
                        { id: 'gpe-v3', type: 'BOX', position: { x: 21.5, y: 0.5, z: 9.5 }, size: { x: 0.8, y: 0.8, z: 0.8 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'building_brown', isInteractable: false },
                    ],
                    isCrossable: false,
                    requiresTeamwork: false,
                    difficultyRating: 0,
                },
                {
                    id: 'gpe-road',
                    name: 'Main Road',
                    type: 'BOUNDARY',
                    bodies: [
                        { id: 'gpe-road-body', type: 'BOX', position: { x: 15, y: 0.02, z: 15 }, size: { x: 30, y: 0.04, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, mass: 0, material: 'road_asphalt', isInteractable: false },
                    ],
                    isCrossable: false,
                    requiresTeamwork: false,
                    difficultyRating: 0,
                },
            ],
            materials: [], // GPE has no physical materials
            spawnPoints: Array.from({ length: 10 }, (_, i) => ({ x: 15, y: 0.5, z: -3 + i * -1 })),
            winConditions: [
                'Present a clear, logical tactical plan within 2 minutes',
                'Address all key terrain features in your plan',
                'Show decisive leadership in your presentation',
            ],
            rules: [
                '5 minutes silent reading, no discussion',
                '2 minutes per individual presentation',
                'Stand and present from the front of the model',
                'Use CONCRETE directions (north, south, etc.) not vague gestures',
            ],
            aiCuePoints: [
                { triggerType: 'TIME', triggerValue: 300, text: 'Reading time is over. First candidate, step up and present your plan. You have 2 minutes.', pressureLevel: 2 },
                { triggerType: 'EVENT', triggerValue: 'candidate_hesitates', text: 'Get to the point. I don\'t have all day.', pressureLevel: 3 },
                { triggerType: 'EVENT', triggerValue: 'vague_plan', text: 'That\'s vague. Be specific. WHERE exactly? HOW many? WHEN?', pressureLevel: 4 },
            ],
            cameraDefault: { position: { x: 15, y: 20, z: -5 }, lookAt: { x: 15, y: 0, z: 15 } },
            lighting: { ambient: 0.5, directional: { position: { x: 15, y: 25, z: 15 }, intensity: 0.6 } },
            skybox: 'INDOOR_GYM',
        };
    }
}
