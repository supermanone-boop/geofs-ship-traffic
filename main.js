'use strict';

(async () => {

    const viewer = geofs.api.viewer;
    const scene = viewer.scene;
    const globe = scene.globe;

    const DISPLAY_DISTANCE = 5000;
    const SHIP_SPACING = 10000;

    const SPEED_KMH = 80;
    const SPEED_MPS = SPEED_KMH / 3.6;

    const STOP_TIME = 180000;

    const LANDING_HEIGHT_TOLERANCE = 12;
    const SHIP_TRACK_DISTANCE = 90;

    const SHIPS = [
        {
            url: "https://www.geo-fs.com/backend/aircraft/repository/CMV%20Probability_267286_5009/prob1.glb",
            scale: 1,
            chance: 85,
            collisionLength: 220,
            collisionWidth: 45,
            deckHeight: 12.3
        },
        {
            url: "https://www.geo-fs.com/models/objects/carrier/carrier.gltf",
            scale: 1,
            chance: 10,
            collisionLength: 330,
            collisionWidth: 800,
            deckHeight: 22
        },
        {
            url: "https://www.geo-fs.com/backend/aircraft/repository/t052_267286_5719/ddg052d1.glb",
            scale: 1,
            chance: 2.5,
            collisionLength: 155,
            collisionWidth: 25,
            deckHeight: 18
        },
        {
            url: "https://www.geo-fs.com/backend/aircraft/repository/t055_267286_5682/055-109.glb",
            scale: 1,
            chance: 2.5,
            collisionLength: 180,
            collisionWidth: 28,
            deckHeight: 20
        }
    ];

    function chooseShip() {
        const r = Math.random() * 100;
        let sum = 0;
        for (const ship of SHIPS) {
            sum += ship.chance;
            if (r <= sum) return ship;
        }
        return SHIPS[0];
    }

    function dist(a, b) {
        return geofs.utils.llaDistanceInMeters(a, b);
    }

    function makeTriangle(p0, p1, p2) {
        const u = [
            p1[0] - p0[0],
            p1[1] - p0[1],
            p1[2] - p0[2]
        ];

        const v = [
            p2[0] - p0[0],
            p2[1] - p0[1],
            p2[2] - p0[2]
        ];

        const n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0]
        ];

        return Object.assign([p0, p1, p2], { u, v, n });
    }

    function makeCollision(length, width) {
        const L = length / 2;
        const W = width / 2;

        const p1 = [-L, -W, 0];
        const p2 = [ L, -W, 0];
        const p3 = [ L,  W, 0];
        const p4 = [-L,  W, 0];

        return [
            makeTriangle(p1, p2, p3),
            makeTriangle(p1, p3, p4)
        ];
    }

    function getPosition(route, distance) {
        if (distance <= 0) {
            return {
                lon: route.points[0][0],
                lat: route.points[0][1],
                segment: 0,
                t: 0
            };
        }

        if (distance >= route.total) {
            const i = route.points.length - 1;

            return {
                lon: route.points[i][0],
                lat: route.points[i][1],
                segment: i - 1,
                t: 1
            };
        }

        let low = 0;
        let high = route.cumulative.length - 1;

        while (low < high) {
            const mid = Math.floor((low + high) / 2);

            if (route.cumulative[mid] < distance) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        const i = Math.max(1, low) - 1;

        const d0 = route.cumulative[i];
        const d1 = route.cumulative[i + 1];

        const t =
            d1 === d0
                ? 0
                : (distance - d0) / (d1 - d0);

        const a = route.points[i];
        const b = route.points[i + 1];

        return {
            lon: a[0] + (b[0] - a[0]) * t,
            lat: a[1] + (b[1] - a[1]) * t,
            segment: i,
            t
        };
    }

    function getHeading(route, position) {
        const i = Math.max(
            0,
            Math.min(route.points.length - 2, position.segment)
        );

        const a = route.points[i];
        const b = route.points[i + 1];

        const lat = position.lat * Math.PI / 180;

        const dLon =
            (b[0] - a[0]) * Math.cos(lat);

        const dLat =
            b[1] - a[1];

        return Math.atan2(dLon, dLat);
    }

    const data = await fetch(
        "https://raw.githubusercontent.com/supermanone-boop/model/main/ferryexport.geojson"
    ).then(r => r.json());

    const routes = [];

    for (const feature of data.features) {

        if (
            !feature.geometry ||
            feature.geometry.type !== "LineString"
        ) continue;

        const raw = feature.geometry.coordinates;

        if (raw.length < 2) continue;

        const points = raw.map(p => [p[0], p[1]]);
        const cumulative = [0];

        let total = 0;

        for (let i = 0; i < points.length - 1; i++) {

            const a = points[i];
            const b = points[i + 1];

            total += dist(
                [a[1], a[0], 0],
                [b[1], b[0], 0]
            );

            cumulative.push(total);
        }

        if (total < 100) continue;

        routes.push({
            points,
            cumulative,
            total,
            name:
                feature.properties?.name ||
                feature.properties?.ref ||
                "FERRY"
        });
    }

    const ships = [];

    for (const route of routes) {

        for (
            let d = 0;
            d < route.total;
            d += SHIP_SPACING
        ) {

            ships.push({
                route,
                distance: d,
                direction: 1,
                waiting: false,
                waitStart: 0,
                type: chooseShip(),
                model: null,
                collision: null,

                playerOnShip: false,

                lastPosition: null,
                followInitialized: false
            });
        }
    }

    function spawn(ship) {

        const position =
            getPosition(
                ship.route,
                ship.distance
            );

        let heading =
            getHeading(
                ship.route,
                position
            );

        if (ship.direction < 0) {
            heading += Math.PI;
        }

        const h =
            globe.getHeight(
                Cesium.Cartographic.fromDegrees(
                    position.lon,
                    position.lat
                )
            ) || 0;

        ship.model =
            scene.primitives.add(
                Cesium.Model.fromGltf({
                    url: ship.type.url,
                    scale: ship.type.scale
                })
            );

        ship.collision = {

            name: "FERRY_COLLISION",

            type: 100,

            url: "",

            location: [
                position.lat,
                position.lon,
                h + ship.type.deckHeight
            ],

            llaLocation: [
                position.lat,
                position.lon,
                h + ship.type.deckHeight
            ],

            htr: [
                heading,
                0,
                0
            ],

            rotateModelOnly: false,

            scale: 1,

            metricOffset: [
                0,
                0,
                0
            ],

            collisionRadius:
                Math.max(
                    ship.type.collisionLength,
                    ship.type.collisionWidth
                ) / 2,

            collisionTriangles:
                makeCollision(
                    ship.type.collisionLength,
                    ship.type.collisionWidth
                ),

            options: {}
        };

        geofs.objects.objectList.push(
            ship.collision
        );

        ship.lastPosition = [
            position.lat,
            position.lon
        ];

        ship.followInitialized = false;

        updateTransform(
            ship,
            position,
            heading,
            h
        );
    }

    function updateTransform(
        ship,
        position,
        heading,
        h
    ) {

        if (
            !ship.model ||
            !ship.collision
        ) return;

        const matrix =
            Cesium.Transforms.headingPitchRollToFixedFrame(
                Cesium.Cartesian3.fromDegrees(
                    position.lon,
                    position.lat,
                    h
                ),
                new Cesium.HeadingPitchRoll(
                    heading,
                    0,
                    0
                )
            );

        ship.model.modelMatrix =
            matrix;

        ship.collision.location = [
            position.lat,
            position.lon,
            h + ship.type.deckHeight
        ];

        ship.collision.llaLocation = [
            position.lat,
            position.lon,
            h + ship.type.deckHeight
        ];

        ship.collision.htr = [
            heading,
            0,
            0
        ];
    }

    function remove(ship) {

        if (ship.model) {

            scene.primitives.remove(
                ship.model
            );

            ship.model = null;
        }

        if (ship.collision) {

            const index =
                geofs.objects.objectList.indexOf(
                    ship.collision
                );

            if (index !== -1) {

                geofs.objects.objectList.splice(
                    index,
                    1
                );
            }

            ship.collision = null;
        }

        ship.playerOnShip = false;

        ship.lastPosition = null;
        ship.followInitialized = false;
    }

    function isPlayerOnShip(
        ship,
        player
    ) {

        if (!ship.collision) {
            return false;
        }

        const position =
            getPosition(
                ship.route,
                ship.distance
            );

        const horizontalDistance =
            dist(
                [
                    player[0],
                    player[1],
                    0
                ],
                [
                    position.lat,
                    position.lon,
                    0
                ]
            );

        if (
            horizontalDistance >
            SHIP_TRACK_DISTANCE
        ) {
            return false;
        }

        const heightDifference =
            Math.abs(
                player[2] -
                ship.collision.llaLocation[2]
            );

        if (
            heightDifference >
            LANDING_HEIGHT_TOLERANCE
        ) {
            return false;
        }

        return true;
    }

    function applyShipMovement(ship) {

        const ac =
            geofs.aircraft.instance;

        if (
            !ac ||
            !ac.llaLocation
        ) return;

        const current =
            getPosition(
                ship.route,
                ship.distance
            );

        const shipPosition = [
            current.lat,
            current.lon
        ];

        if (!ship.lastPosition) {

            ship.lastPosition =
                shipPosition;

            return;
        }

        if (!ship.followInitialized) {

            ship.lastPosition =
                shipPosition;

            ship.followInitialized = true;

            return;
        }

        const dLat =
            shipPosition[0] -
            ship.lastPosition[0];

        const dLon =
            shipPosition[1] -
            ship.lastPosition[1];

        ac.llaLocation[0] += dLat;
        ac.llaLocation[1] += dLon;

        ship.lastPosition =
            shipPosition;
    }

    function updateAircraftFollow() {

        const ac =
            geofs.aircraft.instance;

        if (
            !ac ||
            !ac.llaLocation
        ) return;

        let ridingShip = null;

        for (const ship of ships) {

            if (
                !ship.model ||
                !ship.collision
            ) continue;

            if (
                isPlayerOnShip(
                    ship,
                    ac.llaLocation
                )
            ) {

                ridingShip = ship;

                break;
            }
        }

        if (ridingShip) {

            for (const ship of ships) {
                ship.playerOnShip =
                    ship === ridingShip;
            }

            applyShipMovement(
                ridingShip
            );

        } else {

            for (const ship of ships) {

                ship.playerOnShip =
                    false;

                ship.followInitialized =
                    false;

                ship.lastPosition =
                    null;
            }
        }
    }

    let lastTime =
        performance.now();

    function update(now) {

        const dt =
            Math.min(
                (now - lastTime) / 1000,
                0.1
            );

        lastTime = now;

        const player =
            geofs.aircraft.instance
                .llaLocation;

        for (const ship of ships) {

            const current =
                getPosition(
                    ship.route,
                    ship.distance
                );

            const check = [
                current.lat,
                current.lon,
                0
            ];

            const playerDistance =
                dist(
                    player,
                    check
                );

            if (
                playerDistance <=
                DISPLAY_DISTANCE
            ) {

                if (!ship.model) {
                    spawn(ship);
                }

            } else {

                if (ship.model) {
                    remove(ship);
                }

                continue;
            }

            if (ship.waiting) {

                if (
                    now -
                    ship.waitStart >=
                    STOP_TIME
                ) {

                    ship.waiting =
                        false;

                    ship.direction *= -1;
                }

            } else {

                ship.distance +=
                    SPEED_MPS *
                    dt *
                    ship.direction;

                if (
                    ship.distance >=
                    ship.route.total
                ) {

                    ship.distance =
                        ship.route.total;

                    ship.waiting =
                        true;

                    ship.waitStart =
                        now;
                }

                if (
                    ship.distance <= 0
                ) {

                    ship.distance = 0;

                    ship.waiting =
                        true;

                    ship.waitStart =
                        now;
                }
            }

            const position =
                getPosition(
                    ship.route,
                    ship.distance
                );

            let heading =
                getHeading(
                    ship.route,
                    position
                );

            if (
                ship.direction < 0
            ) {
                heading += Math.PI;
            }

            const h =
                globe.getHeight(
                    Cesium.Cartographic.fromDegrees(
                        position.lon,
                        position.lat
                    )
                ) || 0;

            updateTransform(
                ship,
                position,
                heading,
                h
            );
        }

        updateAircraftFollow();

        requestAnimationFrame(
            update
        );
    }

    requestAnimationFrame(
        update
    );

})();