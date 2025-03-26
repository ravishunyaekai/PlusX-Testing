import { Router } from "express";
import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

import {queryDB} from '../dbUtils.js'; 
import moment from 'moment';
import {numberToWords, formatNumber, generatePdf} from '../utils.js';
import emailQueue from "../emailQueue.js";

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

router.get('web-h', async (req, resp) => {
    return resp.json('Hello node;');    
});

router.post('/upload-pdf', (req, res) => {
    const { file, fileName, dirName } = req.body;

    if (!file || !fileName) {
        return res.status(400).json({ success: false, error: 'Missing file or fileName' });
    }
    
    const pdfBuffer = Buffer.from(file, 'base64');
    
    const savePath = path.join(__dirname, '../public', dirName, fileName);
    
    fs.writeFile(savePath, pdfBuffer, (err) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Failed to save PDF', details: err });
        }

        res.status(200).json({ success: true, pdfPath: savePath });
    });
});

router.get('/invoive-testing', async (req, res) => {
    
    const data = await queryDB(`
        SELECT 
            pci.invoice_id, pci.amount, pci.invoice_date, pcb.booking_id, pcb.start_charging_level, pcb.end_charging_level,
            CASE WHEN pci.currency IS NOT NULL THEN pci.currency ELSE 'AED' END AS currency,
            (SELECT rd.rider_email FROM riders AS rd WHERE rd.rider_id = pci.rider_id) AS rider_email,
            (SELECT rd.rider_name FROM riders AS rd WHERE rd.rider_id = pci.rider_id) AS rider_name
        FROM 
            portable_charger_invoice AS pci
        LEFT JOIN
            portable_charger_booking AS pcb ON pcb.booking_id = pci.request_id
        WHERE 
            pci.invoice_id = 'INVPC0003'
        LIMIT 1
    `, []);
    
    const chargingLevels = ['start_charging_level', 'end_charging_level'].map(key => 
        data && data[key] ? data[key].split(',').map(Number) : []
    );
    const chargingLevelSum = chargingLevels[0].reduce((sum, startLevel, index) => sum + (startLevel - chargingLevels[1][index]), 0);
    
    data.kw           = chargingLevelSum * 0.25;
    data.currency     = data.currency.toUpperCase();
    data.kw_dewa_amt  = data.kw * 0.44;
    data.kw_cpo_amt   = data.kw * 0.26;
    data.delv_charge  = 30;
    data.t_vat_amt    = Math.floor(((data.kw_dewa_amt / 100 * 5) + (data.kw_cpo_amt / 100 * 5) + (data.delv_charge / 100 * 5)) * 100) / 100;
    data.total_amt    = data.kw_dewa_amt + data.kw_cpo_amt + data.delv_charge + data.t_vat_amt;
    data.invoice_date = data.invoice_date ? moment(data.invoice_date).format('MMM D, YYYY') : '';
    
    const invoiceData  = { data, numberToWords, formatNumber  };
    const templatePath = path.join(__dirname, '../views/mail/portable-charger-invoice.ejs');
    const filename     = `INVPC0003-invoice.pdf`;
    const savePdfDir   = 'portable-charger-invoice';
    const pdf          = await generatePdf(templatePath, invoiceData, filename, savePdfDir, req);
    
    if(!pdf || !pdf.success){
        return res.json({ message: ['Failed to generate invoice. Please Try Again!'], status: 0, code: 200 });
    }
    if(pdf.success){
        const html = `<html>
            <body>
                <h4>Dear ${data.rider_name}</h4>
                <p>We hope you are doing well!</p>
                <p>Thank you for choosing our Portable EV Charger service for your EV. We are pleased to inform you that your booking has been successfully completed, and the details of your invoice are attached.</p>
                <p>We appreciate your trust in PlusX Electric and look forward to serving you again.</p>
                <p> Regards,<br/>PlusX Electric Team </p>
            </body>
        </html>`;
        const attachment = {
            filename: `INVPC0003-invoice.pdf`, path: pdf.pdfPath, contentType: 'application/pdf'
        };
    
        emailQueue.addEmail('aman@shunyaekai.tech', 'PlusX Electric: Invoice for Your Portable EV Charger Service', html, attachment);
    }
    
    return res.json({
        invoiceData,
    });
});


export default router;
