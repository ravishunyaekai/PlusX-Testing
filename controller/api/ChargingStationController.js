import db from "../../config/db.js";
import { queryDB } from '../../dbUtils.js';
import validateFields from "../../validation.js";
import { mergeParam, getOpenAndCloseTimings, asyncHandler} from '../../utils.js';

export const stationList = asyncHandler(async (req, resp) => {
    const {rider_id, latitude, longitude, page_no, search_text, sort_by } = mergeParam(req);
        
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id: ["required"], latitude: ["required"], longitude: ["required"], page_no: ["required"]
    });
    
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const limit = 10;
    const start = (page_no * limit) - limit;
    
    let countQuery = `SELECT COUNT(*) AS total FROM public_charging_station_list`;
    let countParams = [];
    if (search_text && search_text.trim() !== '') {
        countQuery += " WHERE station_name LIKE ?";
        countParams.push(`%${search_text}%`);
    }
    const [[{ total }]] = await db.execute(countQuery, countParams);
    const total_page = Math.ceil(total / limit) || 1;

    let query = `SELECT station_id, station_name, address, status, station_image, latitude, longitude, description, charging_for, charger_type, charging_point, price, status, always_open, 
        REPLACE(open_days, "_", ", ") AS open_days, 
        REPLACE(open_timing, "_", ", ") AS open_timing, 
        (6367 * ACOS(COS(RADIANS(?)) * COS(RADIANS(latitude)) * COS(RADIANS(longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(latitude))) ) AS distance 
    FROM public_charging_station_list
    `;
    let queryParams = [latitude, longitude, latitude];
    
    if (search_text && search_text.trim() !== '') {
        query += " WHERE station_name LIKE ?";
        queryParams.push(`%${search_text}%`);
    }

    const sortOrder = (sort_by === 'd') ? 'DESC' : 'ASC';
    query += ` ORDER BY distance ${sortOrder} LIMIT ${start}, ${limit}`;
    
    const [stations] = await db.execute(query, queryParams);

    return resp.json({
        message: ["Charging Station List fetched successfully!"],
        data: stations,
        total_page,
        status: 1,
        code: 200,
        base_url: new URL('/uploads/charging-station-images/', req.protocol + '://' + req.get('host')).href // Generating base URL
    });  
});

export const stationDetail = asyncHandler(async (req, resp) => {
    const {rider_id, station_id, latitude, longitude } = mergeParam(req);
    let gallery = [];
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id: ["required"], station_id: ["required"], latitude: ["required"], longitude: ["required"]
    });

    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    const station = await queryDB(`SELECT station_id, station_name, address, status, station_image, latitude, longitude, description, charging_for, charger_type, charging_point, price, status, always_open, 
        REPLACE(open_days, "_", ", ") AS open_days, 
        REPLACE(open_timing, "_", ", ") AS open_timing, 
        (6367 * ACOS(COS(RADIANS(?)) * COS(RADIANS(latitude)) * COS(RADIANS(longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(latitude))) ) AS distance 
        FROM public_charging_station_list WHERE station_id=?`, 
        [latitude, longitude, latitude, station_id]
    );
    
    station.schedule = getOpenAndCloseTimings(station);

    [gallery] = await db.execute(`SELECT image_name FROM public_charging_station_gallery WHERE station_id = ? ORDER BY id DESC LIMIT 5`, [station_id]);
    const imgName = gallery.map(row => row.image_name);

    return resp.json({
        status: 1,
        code: 200,
        message: ["Charging Station Details fetched successfully!"],
        data: station,
        gallery_data: imgName,
        base_url: new URL('/uploads/charging-station-images/', req.protocol + '://' + req.get('host')).href
    });
});

export const nearestChargerList = asyncHandler(async (req, resp) => {
    const {rider_id, latitude, longitude } = mergeParam(req);
        
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id: ["required"], latitude: ["required"], longitude: ["required"]
    });

    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const [chargers] = await db.execute(`SELECT station_id, station_name, address, status, station_image, latitude, longitude, description, charging_for, charger_type, charging_point, price, status, always_open, 
        REPLACE(open_days, "_", ", ") AS open_days, 
        REPLACE(open_timing, "_", ", ") AS open_timing, 
        (6367 * ACOS(COS(RADIANS(?)) * COS(RADIANS(latitude)) * COS(RADIANS(longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(latitude))) ) AS distance 
        FROM public_charging_station_list ORDER BY distance ASC LIMIT 20
        `,[latitude, longitude ,latitude]
    );

    return resp.json({
        status:1 ,
        code: 200, 
        message: ['Nearest Portable Charger List fetch successfully!'],
        data: chargers
    });

});